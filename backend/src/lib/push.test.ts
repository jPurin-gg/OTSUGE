import assert from "node:assert/strict";
import { createECDH, randomBytes } from "node:crypto";
import dns from "node:dns/promises";
import type { LookupAddress } from "node:dns";
import { EventEmitter } from "node:events";
import https, { Agent, type RequestOptions } from "node:https";
import { test, type TestContext } from "node:test";
import type { Knex } from "knex";
import webpush from "web-push";
import { sendSchedule } from "./push";

const ecdh = createECDH("prime256v1");
ecdh.generateKeys();
const keys = {
  p256dh: ecdh.getPublicKey().toString("base64url"),
  auth: randomBytes(16).toString("base64url"),
};
const vapid = webpush.generateVAPIDKeys();
const endpoint = "https://fcm.googleapis.com/wp/capability-token?opaque=a%2Bb";
const schedule = { id: 7, scheduled_at: "2026-11-13T12:00:00.000Z", message: "配信テスト" };

function configureTest(t: TestContext) {
  // Synthetic test keys only; do not load application env files.
  const values = {
    NEXT_PUBLIC_VAPID_PUBLIC_KEY: vapid.publicKey,
    VAPID_PRIVATE_KEY: vapid.privateKey,
    VAPID_SUBJECT: "mailto:push-test@example.com",
  };
  for (const [name, value] of Object.entries(values)) {
    const previous = process.env[name];
    process.env[name] = value;
    t.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
  }
}

type SubscriptionRow = { id: number; endpoint: string; p256dh: string; auth: string };

function row(id: number, value = endpoint): SubscriptionRow {
  return { id, endpoint: value, ...keys };
}

function fixture(subscriptions: SubscriptionRow[]) {
  const state = {
    deleted: [] as { id: number }[],
    updates: [] as Record<string, unknown>[],
    logs: [] as Record<string, unknown>[],
  };
  const database = ((table: string) => {
    if (table === "schedules as s") {
      const query = {
        join: () => query,
        select: () => query,
        where: () => query,
        first: async () => schedule,
      };
      return query;
    }
    if (table === "subscriptions") {
      return {
        select: async () => subscriptions,
        where: (condition: { id: number }) => ({
          delete: async () => { state.deleted.push(condition); },
        }),
      };
    }
    if (table === "schedules") {
      return {
        where: (condition: { id: number }) => {
          assert.deepEqual(condition, { id: schedule.id });
          return { update: async (values: Record<string, unknown>) => { state.updates.push(values); } };
        },
      };
    }
    if (table === "delivery_logs") {
      return { insert: async (values: Record<string, unknown>) => { state.logs.push(values); } };
    }
    throw new Error(`Unexpected table: ${table}`);
  }) as unknown as Knex;
  return { database, state };
}

test("legacy unsafe endpoints and malformed keys never reach the push library", async (t) => {
  configureTest(t);
  const subscriptions = [
    row(1, "https://example.com/internal"),
    row(2, "https://localhost/internal"),
    row(3, "https://127.0.0.1/internal"),
    row(4, "https://169.254.169.254/latest/meta-data/"),
    row(5, "https://[::1]/internal"),
    row(6, "http://fcm.googleapis.com/wp/token"),
    row(7, "https://fcm.googleapis.com:8443/wp/token"),
    row(8, "https://fcm.googleapis.com.attacker.example/wp/token"),
    { ...row(9), p256dh: "invalid" },
    { ...row(10), auth: "invalid" },
  ];
  const send = t.mock.method(webpush, "sendNotification", async () => ({ statusCode: 201, body: "", headers: {} }));
  const errors = t.mock.method(console, "error", () => {});
  const { database, state } = fixture(subscriptions);

  assert.deepEqual(await sendSchedule(database, schedule.id), { delivered: 0, failed: subscriptions.length, removed: 0 });
  assert.equal(send.mock.callCount(), 0);
  assert.deepEqual(state.deleted, []);
  assert.equal(state.logs[0].failed_count, subscriptions.length);
  assert.equal(errors.mock.callCount(), subscriptions.length);
  for (const call of errors.mock.calls) {
    assert.deepEqual(call.arguments, ["Push delivery failed", { statusCode: undefined }]);
  }
});

test("supported browser endpoints and normalized keys reach web-push with the guarded Agent", async (t) => {
  configureTest(t);
  const endpoints = [
    endpoint,
    "https://fcm.googleapis.com/fcm/send/legacy-token",
    "https://updates.push.services.mozilla.com/wpush/v2/capability-token",
    "https://web.push.apple.com/Q/capability-token",
    "https://wns2-par02p.notify.windows.com/?token=opaque%2Btoken%3D",
  ];
  const subscriptions = endpoints.map((value, index) => ({
    ...row(index + 1, value), p256dh: `${keys.p256dh}=`, auth: `${keys.auth}==`,
  }));
  const send = t.mock.method(webpush, "sendNotification", async () => ({ statusCode: 201, body: "", headers: {} }));
  const { database, state } = fixture(subscriptions);

  assert.deepEqual(await sendSchedule(database, schedule.id), { delivered: endpoints.length, failed: 0, removed: 0 });
  assert.equal(send.mock.callCount(), endpoints.length);
  for (const [index, call] of send.mock.calls.entries()) {
    const [input, payload, options] = call.arguments;
    assert.deepEqual(input, { endpoint: endpoints[index], keys });
    assert.deepEqual(JSON.parse(String(payload)), { title: "OTSUGE", body: schedule.message, url: "/", tag: "otsuge-7" });
    assert.ok(options?.agent instanceof Agent);
    assert.equal(typeof options.agent.options.lookup, "function");
    assert.notEqual(options.agent.options.rejectUnauthorized, false);
    assert.equal(options.agent.options.keepAlive, false);
    assert.equal(options.timeout, 10_000);
    assert.equal(options.proxy, undefined);
  }
  assert.equal(state.updates[0].sent, true);
  assert.equal(state.updates[0].discarded, false);
  assert.equal(state.logs[0].delivered_count, endpoints.length);
});

test("only expired subscriptions are removed and upstream secrets stay out of failure logs", async (t) => {
  configureTest(t);
  const subscriptions = [row(1), row(2), row(3), row(4)];
  const statuses = [201, 404, 410, 503];
  let index = 0;
  t.mock.method(webpush, "sendNotification", async () => {
    const statusCode = statuses[index++];
    if (statusCode === 201) return { statusCode, body: "", headers: {} };
    throw Object.assign(new Error(`secret endpoint=${endpoint} auth=${keys.auth}`), {
      statusCode, endpoint, body: "private upstream response", headers: { authorization: "secret" },
    });
  });
  const errors = t.mock.method(console, "error", () => {});
  const { database, state } = fixture(subscriptions);

  assert.deepEqual(await sendSchedule(database, schedule.id), { delivered: 1, failed: 3, removed: 2 });
  assert.deepEqual(state.deleted, [{ id: 2 }, { id: 3 }]);
  assert.equal(state.logs[0].delivered_count, 1);
  assert.equal(state.logs[0].failed_count, 3);
  assert.equal(state.logs[0].removed_subscription_count, 2);
  assert.equal(errors.mock.callCount(), 1);
  assert.deepEqual(errors.mock.calls[0].arguments, ["Push delivery failed", { statusCode: 503 }]);
});

test("web-push 3.6.7 uses the production guarded Agent and rejects changed or mixed DNS answers", async (t) => {
  configureTest(t);
  const answers: LookupAddress[][] = [
    [{ address: "142.250.1.1", family: 4 }],
    [{ address: "10.0.0.1", family: 4 }],
    [{ address: "142.250.1.1", family: 4 }, { address: "169.254.169.254", family: 4 }],
  ];
  let lookupIndex = 0;
  const resolver = t.mock.method(dns, "lookup", (async (hostname: string, options: unknown) => {
    assert.equal(hostname, "fcm.googleapis.com");
    assert.deepEqual(options, { all: true, verbatim: true });
    return answers[lookupIndex++];
  }) as typeof dns.lookup);
  const selected: LookupAddress[][] = [];
  const transport = t.mock.method(https, "request", ((options: RequestOptions, callback: (response: EventEmitter) => void) => {
    assert.equal(options.hostname, "fcm.googleapis.com");
    assert.equal(options.path, "/wp/capability-token?opaque=a%2Bb");
    assert.equal(options.method, "POST");
    assert.equal(options.timeout, 10_000);
    assert.ok(options.agent instanceof Agent);
    assert.ok(options.headers && "Authorization" in options.headers, "real VAPID signing should run");
    const agentLookup = options.agent.options.lookup as (
      hostname: string,
      options: { all: true },
      callback: (error: Error | null, addresses: LookupAddress[]) => void,
    ) => void;
    const request = Object.assign(new EventEmitter(), {
      write: (body: Buffer) => { assert.ok(body.byteLength > schedule.message.length); return true; },
      end: () => {
        agentLookup(String(options.hostname), { all: true }, (error, addresses) => {
          if (error) request.emit("error", error);
          else {
            selected.push(addresses);
            const response = Object.assign(new EventEmitter(), { statusCode: 201, headers: {} });
            callback(response);
            response.emit("end");
          }
        });
      },
    });
    return request;
  }) as typeof https.request);
  const errors = t.mock.method(console, "error", () => {});

  for (let attempt = 0; attempt < answers.length; attempt += 1) {
    const { database } = fixture([row(1)]);
    assert.deepEqual(await sendSchedule(database, schedule.id), attempt === 0
      ? { delivered: 1, failed: 0, removed: 0 }
      : { delivered: 0, failed: 1, removed: 0 });
  }
  assert.equal(transport.mock.callCount(), answers.length);
  assert.equal(resolver.mock.callCount(), answers.length);
  assert.deepEqual(selected, [answers[0]], "only the already checked public IPs may reach socket selection");
  assert.equal(errors.mock.callCount(), 2);
});

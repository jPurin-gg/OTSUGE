import assert from "node:assert/strict";
import { createECDH } from "node:crypto";
import { EventEmitter } from "node:events";
import type { ClientRequest, IncomingMessage } from "node:http";
import https, { Agent } from "node:https";
import type { Socket } from "node:net";
import { performance } from "node:perf_hooks";
import { setImmediate } from "node:timers/promises";
import test, { type TestContext } from "node:test";
import knex from "knex";
import webpush from "web-push";
import { initializeDb } from "./db";
import { DISPATCH_LIMITS, dispatchDueSchedules, sendSchedule } from "./push";

const START = Date.UTC(2026, 10, 13, 10);
const MINUTE = 60_000;
const success = { statusCode: 201, headers: {}, body: "" };
type Send = typeof webpush.sendNotification;

async function fixture(t: TestContext, count: number, send: Send = async () => success, fakeTimeouts = false) {
  t.mock.timers.enable({ apis: fakeTimeouts ? ["Date", "setTimeout"] : ["Date"], now: START });
  let elapsed = 0;
  t.mock.method(performance, "now", () => elapsed);
  const database = knex({ client: "sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  t.after(() => database.destroy());
  await database.raw("PRAGMA foreign_keys = ON");
  await initializeDb(database);
  // 既存DBへの追加と再起動時の再初期化も確認する。
  await initializeDb(database);
  for (const name of ["NEXT_PUBLIC_VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"]) {
    const previous = process.env[name];
    process.env[name] = "test-only";
    t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
  }
  const configure = t.mock.method(webpush, "setVapidDetails", () => {});
  const push = t.mock.method(webpush, "sendNotification", send);
  t.mock.method(console, "error", () => {});
  const now = new Date().toISOString();
  await database("notifications").insert({
    id: 1, message: "通知", start_time: "09:00", end_time: "22:00", count_per_day: 1,
    min_interval_minutes: 60, enabled: true, created_at: now, updated_at: now,
  });
  async function schedule(id: number, at = START) {
    await database("schedules").insert({
      id, notification_id: 1, scheduled_at: new Date(at).toISOString(), created_at: now, updated_at: now,
    });
  }
  await schedule(1);
  if (count) await database("subscriptions").insert(Array.from({ length: count }, (_, index) => ({
    id: index + 1, endpoint: `https://push.example.test/${index + 1}`, p256dh: "test-key", auth: "test-auth", created_at: now,
  })));
  return { database, push, configure, schedule, setElapsed: (value: number) => { elapsed = value; } };
}

async function waitFor(predicate: () => boolean) {
  for (let attempt = 0; attempt < 10_000; attempt++) {
    if (predicate()) return;
    await setImmediate();
  }
  assert.fail("非同期処理が期待した状態に到達しませんでした。");
}

test("waiting automatic schedules are discarded at the current time, even after the run budget expires", async (t) => {
  const f = await fixture(t, 1, async () => {
    t.mock.timers.tick(35 * MINUTE);
    f.setElapsed(DISPATCH_LIMITS.runTimeoutMs);
    return success;
  });
  await f.database("schedules").update({ scheduled_at: new Date(START - MINUTE).toISOString() });
  await f.schedule(2, START - MINUTE);
  assert.deepEqual(await dispatchDueSchedules(f.database), { processed: 1, delivered: 1, discarded: 1 });
  assert.equal(f.push.mock.callCount(), 1);
  const discarded = await f.database("schedules").where({ id: 2 }).first();
  assert.deepEqual([discarded.sent, discarded.discarded], [1, 1]);
  const log = await f.database("delivery_logs").where({ schedule_id: 2 }).first();
  assert.deepEqual([log.status, log.delivered_count, log.sent_at], ["discarded", 0, new Date(START + 35 * MINUTE).toISOString()]);
});

for (const remaining of [1, 0, -1]) {
  test(`automatic deadline boundary: ${remaining}ms remaining`, async (t) => {
    const f = await fixture(t, 1);
    await f.database("schedules").update({ scheduled_at: new Date(START - 30 * MINUTE + remaining).toISOString() });
    const result = await dispatchDueSchedules(f.database);
    const log = await f.database("delivery_logs").first();
    if (remaining > 0) {
      assert.deepEqual(result, { processed: 1, delivered: 1, discarded: 0 });
      assert.equal(f.push.mock.calls[0].arguments[2]?.timeout, remaining);
      assert.equal(log.status, "sent");
    } else {
      assert.deepEqual(result, { processed: 0, delivered: 0, discarded: 1 });
      assert.equal(f.push.mock.callCount(), 0);
      assert.equal(f.configure.mock.callCount(), 0);
      assert.equal(log.status, "discarded");
    }
  });
}

test("expiration during the subscription query prevents any Push request", async (t) => {
  const f = await fixture(t, 5);
  f.database.on("query-response", (_response, query) => {
    if (query.sql.includes("subscriptions") && query.sql.includes("order by")) {
      t.mock.timers.setTime(START + 30 * MINUTE);
    }
  });
  assert.deepEqual(await dispatchDueSchedules(f.database), { processed: 0, delivered: 0, discarded: 1 });
  assert.equal(f.push.mock.callCount(), 0);
  assert.equal((await f.database("delivery_logs").first()).status, "discarded");
});

test("each subscription rechecks its remaining lifetime, retaining partial counts on discard", async (t) => {
  const f = await fixture(t, 10, async () => {
    t.mock.timers.setTime(START + 30 * MINUTE);
    return success;
  });
  assert.deepEqual(await dispatchDueSchedules(f.database), { processed: 0, delivered: 1, discarded: 1 });
  assert.equal(f.push.mock.callCount(), 1);
  const log = await f.database("delivery_logs").first();
  assert.deepEqual([log.status, log.delivered_count, log.failed_count], ["discarded", 1, 0]);
  assert.equal((await f.database("dispatch_progress")).length, 0);
  await dispatchDueSchedules(f.database);
  assert.equal(f.push.mock.callCount(), 1);
});

test("a short automatic lifetime also shortens the Push request timeout", async (t) => {
  const f = await fixture(t, 1);
  await f.database("schedules").update({ scheduled_at: new Date(START - 30 * MINUTE + 1_500).toISOString() });
  await dispatchDueSchedules(f.database);
  assert.equal(f.push.mock.calls[0].arguments[2]?.timeout, 1_500);
});

test("at most five Push requests run together and all subscription batches complete", async (t) => {
  let active = 0;
  let peak = 0;
  const releases: Array<() => void> = [];
  const f = await fixture(t, 7, async () => {
    active += 1;
    peak = Math.max(active, peak);
    await new Promise<void>((resolve) => releases.push(resolve));
    active -= 1;
    return success;
  });
  const dispatch = dispatchDueSchedules(f.database);
  await waitFor(() => f.push.mock.callCount() === 5);
  assert.equal(active, 5);
  releases.splice(0).forEach((release) => release());
  await waitFor(() => f.push.mock.callCount() === 7);
  assert.equal(active, 2);
  releases.splice(0).forEach((release) => release());
  assert.deepEqual(await dispatch, { processed: 1, delivered: 7, discarded: 0 });
  assert.equal(peak, DISPATCH_LIMITS.concurrency);
  assert.ok(f.push.mock.calls.every((call) => call.arguments[2]?.timeout === DISPATCH_LIMITS.requestTimeoutMs));
});

test("an unresponsive subscription times out, destroys its agent, and lets later subscriptions and schedules proceed", async (t) => {
  let completeLate: (value: typeof success) => void = () => {};
  let calls = 0;
  const f = await fixture(t, 6, async () => {
    if (calls++ === 0) return new Promise<typeof success>((resolve) => { completeLate = resolve; });
    return success;
  }, true);
  await f.schedule(2);
  const dispatch = dispatchDueSchedules(f.database);
  await waitFor(() => f.push.mock.callCount() === 5);
  const agent = f.push.mock.calls[0].arguments[2]?.agent;
  assert.ok(agent instanceof Agent);
  const destroy = t.mock.method(agent, "destroy");
  t.mock.timers.tick(DISPATCH_LIMITS.requestTimeoutMs);
  assert.deepEqual(await dispatch, { processed: 2, delivered: 11, discarded: 0 });
  assert.equal(destroy.mock.callCount(), 1);
  assert.equal(f.push.mock.callCount(), 12);
  const logs = await f.database("delivery_logs").orderBy("schedule_id");
  assert.deepEqual(logs.map((log) => [log.delivered_count, log.failed_count]), [[5, 1], [6, 0]]);
  completeLate(success);
  await setImmediate();
  assert.deepEqual(await f.database("delivery_logs").orderBy("schedule_id"), logs);
});

test("the full-response timer aborts a real web-push request even when partial response data arrives", async (t) => {
  const send = webpush.sendNotification.bind(webpush);
  const f = await fixture(t, 1, send, true);
  const clientKey = createECDH("prime256v1");
  await f.database("subscriptions").update({
    p256dh: clientKey.generateKeys().toString("base64url"), auth: Buffer.alloc(16).toString("base64url"),
  });
  const response = new EventEmitter();
  let destroyed = 0;
  const request = t.mock.method(https, "request", ((options: https.RequestOptions, onResponse: (res: IncomingMessage) => void) => {
    const req = Object.assign(new EventEmitter(), {
      write: () => true,
      end: () => onResponse(response as IncomingMessage),
    });
    assert.ok(options.agent instanceof Agent);
    assert.equal(options.timeout, DISPATCH_LIMITS.requestTimeoutMs);
    Object.assign(options.agent.sockets, { test: [{ destroy: () => {
      destroyed += 1;
      req.emit("error", new Error("test socket destroyed"));
    } } as unknown as Socket] });
    return req as unknown as ClientRequest;
  }) as typeof https.request);
  const dispatch = dispatchDueSchedules(f.database);
  await waitFor(() => request.mock.callCount() === 1);
  t.mock.timers.tick(1_000);
  response.emit("data", Buffer.from("partial response"));
  t.mock.timers.tick(DISPATCH_LIMITS.requestTimeoutMs - 1_000);
  assert.deepEqual(await dispatch, { processed: 1, delivered: 0, discarded: 0 });
  assert.equal(destroyed, 1);
  assert.equal((await f.database("delivery_logs").first()).failed_count, 1);
});

test("a timeout near the run deadline uses only the remaining budget and persists the unfinished cursor", async (t) => {
  const f = await fixture(t, 6, async () => {
    f.setElapsed(DISPATCH_LIMITS.runTimeoutMs);
    return success;
  });
  f.database.on("query-response", (_response, query) => {
    if (query.sql.includes("subscriptions") && query.sql.includes("order by")) {
      f.setElapsed(DISPATCH_LIMITS.runTimeoutMs - 100);
    }
  });
  assert.deepEqual(await dispatchDueSchedules(f.database), { processed: 1, delivered: 1, discarded: 0 });
  assert.equal(f.push.mock.callCount(), 1);
  assert.equal(f.push.mock.calls[0].arguments[2]?.timeout, 100);
  const progress = await f.database("dispatch_progress").first();
  assert.deepEqual([progress.subscription_cursor, progress.delivered_count], [1, 1]);
  assert.equal((await f.database("schedules").first()).sent, 0);
  assert.equal((await f.database("delivery_logs")).length, 0);
});

test("the run budget pauses later schedules without marking them as sent", async (t) => {
  const f = await fixture(t, 1, async () => {
    f.setElapsed(DISPATCH_LIMITS.runTimeoutMs);
    return success;
  });
  await f.schedule(2);
  assert.deepEqual(await dispatchDueSchedules(f.database), { processed: 1, delivered: 1, discarded: 0 });
  assert.equal((await f.database("schedules").where({ id: 2 }).first()).sent, 0);
  f.push.mock.mockImplementation(async () => success);
  assert.deepEqual(await dispatchDueSchedules(f.database), { processed: 1, delivered: 1, discarded: 0 });
});

test("the request cap persists progress, resumes without duplicates, and excludes later subscribers", async (t) => {
  const count = DISPATCH_LIMITS.maxPushRequests + 5;
  const f = await fixture(t, count);
  assert.deepEqual(await dispatchDueSchedules(f.database), { processed: 1, delivered: 200, discarded: 0 });
  let progress = await f.database("dispatch_progress").first();
  assert.deepEqual([progress.subscription_cursor, progress.subscription_limit, progress.delivered_count], [200, count, 200]);
  assert.equal((await f.database("schedules").first()).sent, 0);
  await f.database("subscriptions").insert({ endpoint: "https://push.example.test/new", p256dh: "k", auth: "a", created_at: new Date().toISOString() });
  assert.deepEqual(await dispatchDueSchedules(f.database), { processed: 1, delivered: 5, discarded: 0 });
  assert.equal(new Set(f.push.mock.calls.map((call) => call.arguments[0].endpoint)).size, count);
  assert.equal(f.push.mock.callCount(), count);
  progress = await f.database("dispatch_progress").first();
  assert.equal(progress, undefined);
  const log = await f.database("delivery_logs").first();
  assert.deepEqual([log.status, log.delivered_count], ["sent", count]);
  assert.deepEqual(await dispatchDueSchedules(f.database), { processed: 0, delivered: 0, discarded: 0 });
});

test("resuming an automatic batch after 30 minutes discards its remainder and retains previous delivery counts", async (t) => {
  const f = await fixture(t, DISPATCH_LIMITS.maxPushRequests + 5);
  await dispatchDueSchedules(f.database);
  t.mock.timers.tick(30 * MINUTE);
  assert.deepEqual(await dispatchDueSchedules(f.database), { processed: 0, delivered: 0, discarded: 1 });
  assert.equal(f.push.mock.callCount(), DISPATCH_LIMITS.maxPushRequests);
  const log = await f.database("delivery_logs").first();
  assert.deepEqual([log.status, log.delivered_count], ["discarded", 200]);
});

test("the Push request cap is shared across all schedules in a dispatch", async (t) => {
  const f = await fixture(t, 150);
  await f.schedule(2);
  assert.deepEqual(await dispatchDueSchedules(f.database), { processed: 2, delivered: 200, discarded: 0 });
  assert.equal((await f.database("dispatch_progress").first()).delivered_count, 50);
  assert.deepEqual(await dispatchDueSchedules(f.database), { processed: 1, delivered: 100, discarded: 0 });
  const logs = await f.database("delivery_logs").orderBy("schedule_id");
  assert.deepEqual(logs.map((log) => log.delivered_count), [150, 150]);
});

test("one dispatch processes at most twenty schedules and leaves the rest for the next run", async (t) => {
  const f = await fixture(t, 1);
  for (let id = 2; id <= DISPATCH_LIMITS.maxSchedules + 1; id++) await f.schedule(id);
  assert.deepEqual(await dispatchDueSchedules(f.database), { processed: 20, delivered: 20, discarded: 0 });
  assert.equal((await f.database("schedules").where({ sent: false })).length, 1);
  assert.deepEqual(await dispatchDueSchedules(f.database), { processed: 1, delivered: 1, discarded: 0 });
});

for (const scheduledAt of [START - 60 * MINUTE, START + 60 * MINUTE]) {
  test(`immediate sends bypass automatic expiry and resume through cron (scheduled at ${new Date(scheduledAt).toISOString()})`, async (t) => {
    const f = await fixture(t, DISPATCH_LIMITS.maxPushRequests + 5);
    await f.database("schedules").update({ scheduled_at: new Date(scheduledAt).toISOString() });
    assert.deepEqual(await sendSchedule(f.database, 1), { delivered: 200, failed: 0, removed: 0, pending: true });
    assert.equal((await f.database("dispatch_progress").first()).immediate, 1);
    t.mock.timers.tick(2 * 60 * MINUTE);
    assert.deepEqual(await dispatchDueSchedules(f.database), { processed: 1, delivered: 5, discarded: 0 });
    assert.ok(f.push.mock.calls.every((call) => call.arguments[2]?.timeout === DISPATCH_LIMITS.requestTimeoutMs));
    const log = await f.database("delivery_logs").first();
    assert.deepEqual([log.status, log.delivered_count], ["sent", 205]);
  });
}

test("an administrator can change a pending automatic send into an immediate send across multiple resumes", async (t) => {
  const f = await fixture(t, 2 * DISPATCH_LIMITS.maxPushRequests + 5);
  await dispatchDueSchedules(f.database);
  t.mock.timers.tick(31 * MINUTE);
  assert.deepEqual(await sendSchedule(f.database, 1), { delivered: 200, failed: 0, removed: 0, pending: true });
  assert.equal((await f.database("dispatch_progress").first()).immediate, 1);
  assert.deepEqual(await dispatchDueSchedules(f.database), { processed: 1, delivered: 5, discarded: 0 });
  assert.equal(f.push.mock.callCount(), 405);
  assert.equal((await f.database("delivery_logs").first()).delivered_count, 405);
});

test("an immediate send retains its mode when DB waiting consumes the budget before the first Push", async (t) => {
  const f = await fixture(t, 1);
  await f.database("schedules").update({ scheduled_at: new Date(START - 60 * MINUTE).toISOString() });
  const delay = () => f.setElapsed(DISPATCH_LIMITS.runTimeoutMs);
  f.database.on("query-response", delay);
  assert.deepEqual(await sendSchedule(f.database, 1), { delivered: 0, failed: 0, removed: 0, pending: true });
  f.database.off("query-response", delay);
  assert.equal((await f.database("dispatch_progress").first()).immediate, 1);
  assert.deepEqual(await dispatchDueSchedules(f.database), { processed: 1, delivered: 1, discarded: 0 });
});

test("404 and 410 remove subscriptions while all failures retain their counts and bounded requests", async (t) => {
  const errors = [{ statusCode: 404 }, { statusCode: 410 }, { statusCode: 503 }, new Error("private network error")];
  const f = await fixture(t, 5, async (subscription) => {
    const id = Number(subscription.endpoint.split("/").at(-1));
    if (id <= errors.length) throw errors[id - 1];
    return success;
  });
  assert.deepEqual(await sendSchedule(f.database, 1), { delivered: 1, failed: 4, removed: 2, pending: false });
  const log = await f.database("delivery_logs").first();
  assert.deepEqual([log.delivered_count, log.failed_count, log.removed_subscription_count], [1, 4, 2]);
  assert.deepEqual((await f.database("subscriptions").orderBy("id")).map((row) => row.id), [3, 4, 5]);
});

test("no subscriptions completes without requiring VAPID configuration", async (t) => {
  const f = await fixture(t, 0);
  assert.deepEqual(await dispatchDueSchedules(f.database), { processed: 1, delivered: 0, discarded: 0 });
  assert.equal(f.configure.mock.callCount(), 0);
  assert.equal((await f.database("delivery_logs").first()).status, "sent");
});

test("finalization rolls back both schedule state and log on persistence failure, then resumes", async (t) => {
  const f = await fixture(t, 1);
  await f.database.raw("CREATE TRIGGER reject_log BEFORE INSERT ON delivery_logs BEGIN SELECT RAISE(ABORT, 'test failure'); END");
  await assert.rejects(dispatchDueSchedules(f.database), /test failure/);
  assert.equal((await f.database("schedules").first()).sent, 0);
  assert.equal((await f.database("dispatch_progress").first()).subscription_cursor, 1);
  assert.equal((await f.database("delivery_logs")).length, 0);
  await f.database.raw("DROP TRIGGER reject_log");
  assert.deepEqual(await dispatchDueSchedules(f.database), { processed: 1, delivered: 0, discarded: 0 });
  assert.equal(f.push.mock.callCount(), 1);
  assert.equal((await f.database("delivery_logs").first()).delivered_count, 1);
});

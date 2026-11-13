import assert from "node:assert/strict";
import { createECDH, randomBytes } from "node:crypto";
import test from "node:test";
import type { Knex } from "knex";
import { PushEndpointError, validatePushEndpointAddress } from "./push-security";
import { subscriptionInput } from "./subscription-input";
import {
  createSubscriptionHandlers,
  createSubscriptionRateLimiter,
  MAX_SUBSCRIPTION_BODY_BYTES,
  readSubscriptionBody,
  SUBSCRIPTION_RATE_CAPACITY,
} from "./subscription-request";

const ecdh = createECDH("prime256v1");
ecdh.generateKeys();
const keys = { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") };
const endpoint = "https://fcm.googleapis.com/wp/example-token";
const input = { endpoint, keys };

function request(body: unknown = input, headers?: HeadersInit) {
  return new Request("https://otsuge.example/api/subscriptions", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
}

function fixture(options: {
  validateAddress?: (endpoint: string) => Promise<void>;
  rateLimit?: () => number;
} = {}) {
  const state = {
    databaseCalls: 0,
    dnsCalls: 0,
    inserted: [] as Record<string, unknown>[],
    updated: [] as Record<string, unknown>[],
    deleted: [] as Record<string, unknown>[],
    existing: undefined as Record<string, unknown> | undefined,
  };
  const database = ((table: string) => {
    assert.equal(table, "subscriptions");
    return {
      where(where: Record<string, unknown>) {
        return {
          first: async () => state.existing,
          update: async (values: Record<string, unknown>) => { state.updated.push(values); },
          delete: async () => { state.deleted.push(where); },
        };
      },
      insert: async (values: Record<string, unknown>) => { state.inserted.push(values); },
    };
  }) as unknown as Knex;
  const handlers = createSubscriptionHandlers({
    getDatabase: async () => { state.databaseCalls += 1; return database; },
    validateAddress: async (value) => {
      state.dnsCalls += 1;
      assert.equal(state.databaseCalls, 0, "DNS validation must precede database access");
      await options.validateAddress?.(value);
    },
    rateLimit: options.rateLimit ?? (() => 0),
  });
  return { state, ...handlers };
}

test("browser subscriptions can be inserted with opaque provider endpoints", async () => {
  for (const value of [
    endpoint,
    "https://fcm.googleapis.com/fcm/send/legacy-token",
    "https://updates.push.services.mozilla.com/wpush/v2/example-token",
    "https://web.push.apple.com/Q/example-token",
    "https://wns2-par02p.notify.windows.com/?token=opaque%2Btoken%3D",
  ]) {
    const { state, POST } = fixture();
    const response = await POST(request({ ...input, endpoint: value, expirationTime: null }));
    assert.equal(response.status, 200, value);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(state.inserted.length, 1);
    assert.equal(state.inserted[0].endpoint, value);
    assert.equal(state.inserted[0].p256dh, keys.p256dh);
    assert.equal(state.inserted[0].auth, keys.auth);
    assert.equal(state.dnsCalls, 1);
  }
});

test("canonical padding is accepted and normalized when updating a subscription", async () => {
  const { state, POST } = fixture();
  state.existing = { endpoint };
  const response = await POST(request({ endpoint, keys: { p256dh: `${keys.p256dh}=`, auth: `${keys.auth}==` } }));
  assert.equal(response.status, 200);
  assert.equal(state.inserted.length, 0);
  assert.deepEqual(state.updated, [keys]);
});

test("malformed, noncanonical and wrong-size keys are rejected before DNS and database access", async () => {
  const invalidKeys = [
    { ...keys, p256dh: "x" },
    { ...keys, p256dh: Buffer.alloc(65, 4).toString("base64url") }, // off-curve
    { ...keys, p256dh: ecdh.getPublicKey(undefined, "compressed").toString("base64url") },
    { ...keys, p256dh: `${keys.p256dh}==` },
    { ...keys, p256dh: `${keys.p256dh.slice(0, -1)}!` },
    { ...keys, auth: "" },
    { ...keys, auth: Buffer.alloc(15).toString("base64url") },
    { ...keys, auth: Buffer.alloc(17).toString("base64url") },
    { ...keys, auth: `${keys.auth}=` },
    { ...keys, auth: "A".repeat(21) + "B" }, // nonzero unused base64 bits
    { ...keys, auth: "A".repeat(21) + "/" }, // standard base64 alphabet
    { ...keys, auth: "A".repeat(25) },
  ];
  for (const value of invalidKeys) {
    const { state, POST } = fixture();
    const response = await POST(request({ endpoint, keys: value }));
    assert.equal(response.status, 400, JSON.stringify(value));
    assert.equal(state.dnsCalls, 0);
    assert.equal(state.databaseCalls, 0);
  }
});

test("unsafe endpoint syntax is rejected before DNS and database access", async () => {
  for (const value of [
    "https://example.com/push", "http://fcm.googleapis.com/wp/token", "https://localhost/push",
    "https://127.0.0.1/push", "https://10.0.0.1/push", "https://169.254.169.254/push",
    "https://[::1]/push", "https://fcm.googleapis.com.evil.example/wp/token",
    "https://fcm.googleapis.com:8443/wp/token", "https://user@fcm.googleapis.com/wp/token",
    `https://fcm.googleapis.com/wp/${"a".repeat(2048)}`,
  ]) {
    const { state, POST } = fixture();
    assert.equal((await POST(request({ ...input, endpoint: value }))).status, 400, value);
    assert.equal(state.dnsCalls, 0);
    assert.equal(state.databaseCalls, 0);
  }
});

test("allowed hosts resolving to private or mixed public/private addresses are never stored", async () => {
  for (const addresses of [
    [{ address: "127.0.0.1", family: 4 }],
    [{ address: "10.0.0.1", family: 4 }],
    [{ address: "169.254.169.254", family: 4 }],
    [{ address: "fd00::1", family: 6 }],
    [{ address: "142.250.1.1", family: 4 }, { address: "192.168.1.1", family: 4 }],
  ]) {
    const { state, POST } = fixture({
      validateAddress: (value) => validatePushEndpointAddress(value, async () => addresses),
    });
    assert.equal((await POST(request())).status, 400);
    assert.equal(state.dnsCalls, 1);
    assert.equal(state.databaseCalls, 0);
  }
});

test("DNS policy failures are returned as a client error", async () => {
  const { state, POST } = fixture({ validateAddress: async () => { throw new PushEndpointError(); } });
  assert.equal((await POST(request())).status, 400);
  assert.equal(state.databaseCalls, 0);
});

test("oversize declared, undeclared and understated bodies are rejected before DNS/DB", async () => {
  const body = JSON.stringify({ ...input, extra: "a".repeat(MAX_SUBSCRIPTION_BODY_BYTES) });
  for (const length of [undefined, String(body.length), "1"]) {
    const { state, POST } = fixture();
    const response = await POST(new Request("https://otsuge.example/api/subscriptions", {
      method: "POST", body, headers: length === undefined ? {} : { "Content-Length": length },
    }));
    assert.equal(response.status, 413);
    assert.equal(state.dnsCalls, 0);
    assert.equal(state.databaseCalls, 0);
  }
});

test("the streaming body bound counts bytes and cancels an oversized stream", async () => {
  let canceled = false;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode('"' + "あ".repeat(1400) + '"'));
    },
    cancel() { canceled = true; },
  });
  const { state, POST } = fixture();
  const response = await POST(new Request("https://otsuge.example/api/subscriptions", {
    method: "POST", body: stream, duplex: "half",
  } as RequestInit));
  assert.equal(response.status, 413);
  assert.equal(canceled, true);
  assert.equal(state.databaseCalls, 0);
});

test("the body reader accepts JSON at the exact byte limit", async () => {
  const body = " ".repeat(MAX_SUBSCRIPTION_BODY_BYTES - 2) + "{}";
  assert.deepEqual(await readSubscriptionBody(new Request("https://otsuge.example", { method: "POST", body })), {});
});

test("malformed JSON, UTF-8, missing body and Content-Length are client errors", async () => {
  for (const init of [
    { body: "{" },
    { body: new Uint8Array([0xff]) },
    {},
    { body: "{}", headers: { "Content-Length": "bad" } },
  ]) {
    const { state, POST } = fixture();
    const response = await POST(new Request("https://otsuge.example", { method: "POST", ...init }));
    assert.equal(response.status, 400);
    assert.equal(state.databaseCalls, 0);
    assert.equal(state.dnsCalls, 0);
  }
});

test("invalid requests count toward the process rate limit and spoofed IP headers cannot bypass it", async () => {
  let now = 0;
  const { state, POST } = fixture({ rateLimit: createSubscriptionRateLimiter(() => now) });
  for (let index = 0; index < SUBSCRIPTION_RATE_CAPACITY; index += 1) {
    assert.equal((await POST(request({}, { "X-Forwarded-For": `192.0.2.${index}` }))).status, 400);
  }
  const limited = await POST(request(input, { "X-Forwarded-For": "198.51.100.1" }));
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get("Retry-After"), "2");
  assert.equal(state.databaseCalls, 0);
  assert.equal(state.dnsCalls, 0);
  now += 2000;
  assert.equal((await POST(request())).status, 200);
});

test("rate tokens refill to the bounded capacity", () => {
  let now = 0;
  const limit = createSubscriptionRateLimiter(() => now);
  for (let index = 0; index < SUBSCRIPTION_RATE_CAPACITY; index += 1) assert.equal(limit(), 0);
  assert.equal(limit(), 2);
  now = 1000;
  assert.equal(limit(), 1);
  now = 2000;
  assert.equal(limit(), 0);
  now = 10 ** 9;
  for (let index = 0; index < SUBSCRIPTION_RATE_CAPACITY; index += 1) assert.equal(limit(), 0);
  assert.equal(limit(), 2);
});

test("unsubscribe is bounded and shares the registration rate limit", async () => {
  const { state, POST, DELETE } = fixture({ rateLimit: createSubscriptionRateLimiter(() => 0) });
  assert.equal((await DELETE(request({ endpoint }))).status, 200);
  assert.deepEqual(state.deleted, [{ endpoint }]);
  assert.equal(state.dnsCalls, 0, "unsubscribe makes no outbound request");
  assert.equal((await DELETE(request({ endpoint, extra: "a".repeat(MAX_SUBSCRIPTION_BODY_BYTES) }))).status, 413);
  for (let index = 2; index < SUBSCRIPTION_RATE_CAPACITY; index += 1) {
    assert.equal((await POST(request({}))).status, 400);
  }
  assert.equal((await DELETE(request({ endpoint }))).status, 429);
});

test("subscription serialization keeps browser metadata optional", () => {
  assert.deepEqual(subscriptionInput.parse({ ...input, expirationTime: null }), input);
});

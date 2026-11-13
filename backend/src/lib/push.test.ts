import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { Knex } from "knex";
import webpush from "web-push";
import { sendSchedule } from "./push";

const now = Date.parse("2026-11-14T12:00:00.000Z");

function setup(t: TestContext, ageMs: number, subscriptionCount = 1) {
  t.mock.timers.enable({ apis: ["Date"], now });
  for (const key of ["NEXT_PUBLIC_VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"]) {
    const previous = process.env[key];
    process.env[key] = "test-only";
    t.after(() => {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    });
  }
  t.mock.method(webpush, "setVapidDetails", () => {});
  const send = t.mock.method(webpush, "sendNotification", async () => ({}));
  const subscriptions = Array.from({ length: subscriptionCount }, (_, id) => ({
    id, endpoint: `https://push.example/${id}`, p256dh: "test-key", auth: "test-auth",
  }));
  // Only the query results are stubbed; sendSchedule constructs the real payload/options.
  const database = ((table: string) => {
    if (table === "schedules as s") {
      const query = {
        join: () => query,
        select: () => query,
        where: () => query,
        first: async () => ({
          id: 1, scheduled_at: new Date(now - ageMs).toISOString(), message: "水を飲め",
        }),
      };
      return query;
    }
    if (table === "subscriptions") return { select: async () => subscriptions };
    if (table === "schedules") return { where: () => ({ update: async () => 1 }) };
    if (table === "delivery_logs") return { insert: async () => [1] };
    throw new Error(`Unexpected table: ${table}`);
  }) as unknown as Knex;
  return { database, send };
}

for (const [label, ageMs, ttl] of [
  ["on-time delivery", 0, 1800],
  ["delayed delivery", 10 * 60 * 1000, 1200],
  ["fractional seconds are rounded down", 1001, 1798],
  ["future schedule sent manually is capped", -60 * 60 * 1000, 1800],
  ["one second remains", 30 * 60 * 1000 - 1000, 1],
] as const) {
  test(`push options: ${label}`, async (t) => {
    const { database, send } = setup(t, ageMs);
    assert.deepEqual(await sendSchedule(database, 1), { delivered: 1, failed: 0, removed: 0 });
    assert.equal(send.mock.callCount(), 1);
    assert.deepEqual(send.mock.calls[0].arguments[2], { TTL: ttl, urgency: "normal" });
    assert.deepEqual(JSON.parse(send.mock.calls[0].arguments[1] as string), {
      title: "OTSUGE", body: "水を飲め", url: "/", tag: "otsuge-1",
    });
  });
}

for (const ageMs of [30 * 60 * 1000 - 999, 30 * 60 * 1000, 31 * 60 * 1000]) {
  test(`push is skipped when no whole second remains (age ${ageMs} ms)`, async (t) => {
    const { database, send } = setup(t, ageMs);
    assert.deepEqual(await sendSchedule(database, 1), { delivered: 0, failed: 0, removed: 0 });
    assert.equal(send.mock.callCount(), 0);
  });
}

test("TTL is recalculated for each subscription and sending stops at expiry", async (t) => {
  const { database, send } = setup(t, 30 * 60 * 1000 - 3000, 3);
  send.mock.mockImplementation(async () => {
    t.mock.timers.tick(2000);
    return {};
  });
  assert.deepEqual(await sendSchedule(database, 1), { delivered: 2, failed: 0, removed: 0 });
  assert.deepEqual(send.mock.calls.map((call) => call.arguments[2]), [
    { TTL: 3, urgency: "normal" },
    { TTL: 1, urgency: "normal" },
  ]);
});

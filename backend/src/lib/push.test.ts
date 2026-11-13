import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import knex from "knex";
import webpush from "web-push";
import { initializeDb } from "./db";
import { dispatchDueSchedules, sendSchedule } from "./push";
import { generateDailySchedules } from "./scheduler";

const START = Date.UTC(2026, 10, 13, 3);
const MINUTE = 60_000;
const success = { statusCode: 201, headers: {}, body: "" };
type Send = typeof webpush.sendNotification;

async function fixture(t: TestContext, subscriptions: number, send: Send = async () => success) {
  t.mock.timers.enable({ apis: ["Date"], now: START });
  const database = knex({ client: "sqlite3", connection: { filename: ":memory:" }, useNullAsDefault: true });
  t.after(() => database.destroy());
  await database.raw("PRAGMA foreign_keys = ON");
  await initializeDb(database);
  for (const name of ["NEXT_PUBLIC_VAPID_PUBLIC_KEY", "VAPID_PRIVATE_KEY", "VAPID_SUBJECT"]) {
    const previous = process.env[name];
    process.env[name] = "test-only";
    t.after(() => { if (previous === undefined) delete process.env[name]; else process.env[name] = previous; });
  }
  const configure = t.mock.method(webpush, "setVapidDetails", () => {});
  const push = t.mock.method(webpush, "sendNotification", send);
  const now = new Date().toISOString();
  await database("notifications").insert({
    id: 1, message: "通知", start_time: "09:00", end_time: "22:00", count_per_day: 1,
    min_interval_minutes: 60, enabled: true, created_at: now, updated_at: now,
  });
  await database("schedules").insert({ id: 1, notification_id: 1, scheduled_at: now, created_at: now, updated_at: now });
  if (subscriptions) await database("subscriptions").insert(Array.from({ length: subscriptions }, (_, index) => ({
    id: index + 1, endpoint: `https://push.example.test/${index + 1}`, p256dh: "test-key", auth: "test-auth", created_at: now,
  })));
  return { database, push, configure };
}

test("mixed success, 503 and 410 retries only the failed subscription and retains partial results", async (t) => {
  let transientAttempts = 0;
  const { database, push } = await fixture(t, 3, async (subscription) => {
    if (subscription.endpoint.endsWith("/3")) throw { statusCode: 410 };
    if (subscription.endpoint.endsWith("/2") && transientAttempts++ === 0) throw { statusCode: 503, body: "private response", endpoint: "private endpoint" };
    return success;
  });
  assert.deepEqual(await dispatchDueSchedules(database), { processed: 1, delivered: 1, discarded: 0 });
  const rows = await database("schedule_deliveries").orderBy("subscription_id");
  assert.deepEqual(rows.map((row) => [row.status, row.attempt_count, row.last_error]), [
    ["sent", 1, null], ["retrying", 1, "HTTP 503"], ["removed", 1, "HTTP 410"],
  ]);
  assert.equal(rows[1].next_attempt_at, new Date(START + MINUTE).toISOString());
  assert.equal(await database("subscriptions").where({ id: 3 }).first(), undefined);
  assert.equal((await database("schedules").first()).sent, 0);
  let log = await database("delivery_logs").orderBy("id", "desc").first();
  assert.deepEqual([log.status, log.delivered_count, log.failed_count, log.pending_count], ["retrying", 1, 1, 1]);

  // 再試行中に増えた購読は、この予定の対象へ追加しない。
  await database("subscriptions").insert({ id: 4, endpoint: "https://push.example.test/4", p256dh: "k", auth: "a", created_at: new Date().toISOString() });
  assert.deepEqual(await dispatchDueSchedules(database), { processed: 0, delivered: 0, discarded: 0 });
  assert.equal((await database("delivery_logs")).length, 1);
  t.mock.timers.tick(MINUTE);
  assert.deepEqual(await dispatchDueSchedules(database), { processed: 1, delivered: 1, discarded: 0 });
  assert.deepEqual(push.mock.calls.map((call) => call.arguments[0].endpoint), [
    "https://push.example.test/1", "https://push.example.test/2", "https://push.example.test/3", "https://push.example.test/2",
  ]);
  log = await database("delivery_logs").orderBy("id", "desc").first();
  assert.deepEqual([log.status, log.delivered_count, log.failed_count, log.pending_count, log.removed_subscription_count], ["partial", 2, 1, 0, 1]);
  assert.equal((await database("schedules").first()).delivery_status, "partial");
  assert.equal((await database("schedule_deliveries").where({ subscription_id: 2 }).first()).attempt_count, 2);
  await sendSchedule(database, 1);
  await dispatchDueSchedules(database);
  assert.equal(push.mock.callCount(), 4);
});

test("a fully failed transient delivery recovers and becomes sent", async (t) => {
  let attempts = 0;
  const { database, push } = await fixture(t, 1, async () => {
    if (attempts++ === 0) throw { statusCode: 503 };
    return success;
  });
  await dispatchDueSchedules(database);
  assert.equal((await database("schedules").first()).delivery_status, "retrying");
  assert.equal((await database("delivery_logs").first()).status, "retrying");
  t.mock.timers.tick(MINUTE);
  await dispatchDueSchedules(database);
  const row = await database("schedule_deliveries").first();
  assert.deepEqual([row.status, row.attempt_count, row.last_error, row.next_attempt_at], ["sent", 2, "HTTP 503", null]);
  assert.equal((await database("schedules").first()).delivery_status, "sent");
  assert.equal((await database("delivery_logs").orderBy("id", "desc").first()).status, "sent");
  assert.equal(push.mock.callCount(), 2);
});

test("backoff is persisted, capped at eight minutes, and never sends at or after the 30-minute deadline", async (t) => {
  const { database, push } = await fixture(t, 1, async () => { throw { statusCode: 503 }; });
  const minutes = [0, 1, 3, 7, 15, 23];
  const nextMinutes = [1, 3, 7, 15, 23, 30];
  for (let index = 0; index < minutes.length; index++) {
    t.mock.timers.setTime(START + minutes[index] * MINUTE);
    await dispatchDueSchedules(database);
    const row = await database("schedule_deliveries").first();
    assert.equal(row.attempt_count, index + 1);
    assert.equal(row.next_attempt_at, new Date(START + nextMinutes[index] * MINUTE).toISOString());
    // 管理画面からの即時送信でもバックオフを飛ばさない。
    await sendSchedule(database, 1);
    assert.equal(push.mock.callCount(), index + 1);
  }
  t.mock.timers.setTime(START + 30 * MINUTE);
  assert.deepEqual(await dispatchDueSchedules(database), { processed: 0, delivered: 0, discarded: 1 });
  const row = await database("schedule_deliveries").first();
  assert.deepEqual([row.status, row.attempt_count, row.last_error, row.next_attempt_at], ["discarded", 6, "HTTP 503", null]);
  assert.deepEqual((await database("schedules").select("sent", "discarded", "delivery_status").first()), { sent: 1, discarded: 1, delivery_status: "discarded" });
  const log = await database("delivery_logs").orderBy("id", "desc").first();
  assert.deepEqual([log.status, log.delivered_count, log.failed_count, log.pending_count], ["discarded", 0, 1, 0]);
  t.mock.timers.tick(MINUTE);
  await sendSchedule(database, 1);
  await dispatchDueSchedules(database);
  assert.equal(push.mock.callCount(), 6);
});

test("an overdue first dispatch records discarded recipients without Push configuration or attempts", async (t) => {
  const { database, push, configure } = await fixture(t, 1);
  t.mock.timers.tick(30 * MINUTE);
  assert.deepEqual(await dispatchDueSchedules(database), { processed: 0, delivered: 0, discarded: 1 });
  const row = await database("schedule_deliveries").first();
  assert.deepEqual([row.status, row.attempt_count, row.last_error], ["discarded", 0, "DELIVERY_DEADLINE_EXCEEDED"]);
  assert.equal(push.mock.callCount(), 0);
  assert.equal(configure.mock.callCount(), 0);
});

test("partial delivery remains partial when remaining retries expire", async (t) => {
  const { database, push } = await fixture(t, 2, async (subscription) => {
    if (subscription.endpoint.endsWith("/2")) throw { statusCode: 503 };
    return success;
  });
  await dispatchDueSchedules(database);
  t.mock.timers.tick(31 * MINUTE);
  await dispatchDueSchedules(database);
  const schedule = await database("schedules").first();
  assert.equal(schedule.sent, 1);
  assert.equal(schedule.delivery_status, "partial");
  const log = await database("delivery_logs").orderBy("id", "desc").first();
  assert.deepEqual([log.status, log.delivered_count, log.failed_count, log.pending_count], ["partial", 1, 1, 0]);
  assert.equal(push.mock.callCount(), 2);
});

test("429, 408, 5xx and network errors retry, other 4xx fail, and 404/410 remove subscriptions", async (t) => {
  const errors = [{ statusCode: 429 }, { statusCode: 408 }, { statusCode: 500 }, { statusCode: 599 },
    { code: "ECONNRESET", message: "private data" }, { statusCode: 400 }, { statusCode: 403 }, { statusCode: 413 }, { statusCode: 404 }, { statusCode: 410 }];
  const { database } = await fixture(t, errors.length, async (subscription) => {
    throw errors[Number(subscription.endpoint.split("/").at(-1)) - 1];
  });
  await dispatchDueSchedules(database);
  const rows = await database("schedule_deliveries").orderBy("subscription_id");
  assert.deepEqual(rows.map((row) => row.status), ["retrying", "retrying", "retrying", "retrying", "retrying", "failed", "failed", "failed", "removed", "removed"]);
  assert.equal(rows[4].last_error, "NETWORK ECONNRESET");
  assert.equal((await database("subscriptions")).length, 8);
});

test("all permanent failures finish as failed and are not retried", async (t) => {
  const { database, push } = await fixture(t, 1, async () => { throw { statusCode: 400 }; });
  await dispatchDueSchedules(database);
  assert.equal((await database("schedules").first()).delivery_status, "failed");
  const log = await database("delivery_logs").first();
  assert.deepEqual([log.status, log.failed_count, log.pending_count], ["failed", 1, 0]);
  t.mock.timers.tick(MINUTE);
  await dispatchDueSchedules(database);
  await sendSchedule(database, 1);
  assert.equal(push.mock.callCount(), 1);
});

test("a subscription deleted while waiting leaves a retained result without another attempt", async (t) => {
  const { database, push } = await fixture(t, 1, async () => { throw { statusCode: 503 }; });
  await dispatchDueSchedules(database);
  await database("subscriptions").where({ id: 1 }).delete();
  t.mock.timers.tick(MINUTE);
  await dispatchDueSchedules(database);
  const row = await database("schedule_deliveries").first();
  assert.deepEqual([row.subscription_id, row.status, row.attempt_count, row.next_attempt_at], [1, "removed", 1, null]);
  assert.equal((await database("schedules").first()).delivery_status, "failed");
  assert.equal(push.mock.callCount(), 1);
});

test("deadline is rechecked during fanout and Push TTL is bounded by the remaining window", async (t) => {
  const { database, push } = await fixture(t, 2, async (_subscription, _payload, options) => {
    assert.equal(options?.TTL, 1800);
    assert.equal(options?.timeout, 10_000);
    t.mock.timers.tick(30 * MINUTE);
    return success;
  });
  await dispatchDueSchedules(database);
  assert.equal(push.mock.callCount(), 1);
  assert.deepEqual((await database("schedule_deliveries").orderBy("id")).map((row) => [row.status, row.attempt_count]), [["sent", 1], ["discarded", 0]]);
  assert.equal((await database("schedules").first()).delivery_status, "partial");
});

test("a failure finishing after the deadline is discarded without scheduling a retry", async (t) => {
  const { database } = await fixture(t, 1, async () => {
    t.mock.timers.tick(30 * MINUTE);
    throw { statusCode: 503 };
  });
  await dispatchDueSchedules(database);
  const row = await database("schedule_deliveries").first();
  assert.deepEqual([row.status, row.attempt_count, row.next_attempt_at], ["discarded", 1, null]);
});

test("a deadline reached during preparation prevents the Push call and does not count an attempt", async (t) => {
  const { database, push, configure } = await fixture(t, 1);
  configure.mock.mockImplementation(() => { t.mock.timers.tick(30 * MINUTE); });
  await dispatchDueSchedules(database);
  const row = await database("schedule_deliveries").first();
  assert.deepEqual([row.status, row.attempt_count], ["discarded", 0]);
  assert.equal(push.mock.callCount(), 0);
});

test("early manual delivery retries via cron and schedule edits cannot extend its deadline", async (t) => {
  let attempts = 0;
  const { database, push } = await fixture(t, 1, async () => {
    if (attempts++ === 0) throw { statusCode: 503 };
    return success;
  });
  await database("schedules").update({ scheduled_at: new Date(START + 24 * 60 * MINUTE).toISOString() });
  assert.equal((await dispatchDueSchedules(database)).processed, 0);
  await sendSchedule(database, 1);
  assert.equal((await database("schedules").first()).delivery_deadline_at, new Date(START + 30 * MINUTE).toISOString());
  t.mock.timers.tick(MINUTE);
  assert.equal((await dispatchDueSchedules(database)).delivered, 1);
  assert.equal(push.mock.callCount(), 2);
});

test("editing a pending retry into the future still expires at its original deadline", async (t) => {
  const { database, push } = await fixture(t, 1, async () => { throw { statusCode: 503 }; });
  await dispatchDueSchedules(database);
  await database("schedules").update({ scheduled_at: new Date(START + 24 * 60 * MINUTE).toISOString() });
  t.mock.timers.tick(30 * MINUTE);
  await dispatchDueSchedules(database);
  assert.equal((await database("schedule_deliveries").first()).status, "discarded");
  assert.equal(push.mock.callCount(), 1);
});

test("daily regeneration preserves started deliveries and their successful recipients", async (t) => {
  const { database, push } = await fixture(t, 2, async (subscription) => {
    if (subscription.endpoint.endsWith("/2")) throw { statusCode: 503 };
    return success;
  });
  await dispatchDueSchedules(database);
  await generateDailySchedules(database);
  assert.ok(await database("schedules").where({ id: 1 }).first());
  assert.deepEqual((await database("schedule_deliveries").where({ schedule_id: 1 }).orderBy("id")).map((row) => row.status), ["sent", "retrying"]);
  t.mock.timers.tick(MINUTE);
  await sendSchedule(database, 1);
  assert.equal(push.mock.calls.filter((call) => call.arguments[0].endpoint.endsWith("/1")).length, 1);
});

test("no subscriptions completes once without requiring Push configuration", async (t) => {
  const { database, configure } = await fixture(t, 0);
  await dispatchDueSchedules(database);
  assert.equal((await database("schedules").first()).delivery_status, "sent");
  await sendSchedule(database, 1);
  assert.equal((await database("delivery_logs")).length, 1);
  assert.equal(configure.mock.callCount(), 0);
});

test("schema upgrades preserve legacy completed schedules and are repeatable", async (t) => {
  const { database } = await fixture(t, 0);
  await database.schema.dropTable("schedule_deliveries");
  await database.schema.alterTable("schedules", (table) => { table.dropColumn("delivery_status"); table.dropColumn("delivery_deadline_at"); });
  await database.schema.alterTable("delivery_logs", (table) => { table.dropColumn("pending_count"); });
  await database("schedules").update({ sent: true });
  const now = new Date().toISOString();
  await database("schedules").insert({ id: 2, notification_id: 1, scheduled_at: now, sent: true, discarded: true, created_at: now, updated_at: now });
  await initializeDb(database);
  await initializeDb(database);
  assert.deepEqual((await database("schedules").orderBy("id")).map((row) => row.delivery_status), ["sent", "discarded"]);
  await database("schedule_deliveries").insert({ schedule_id: 1, subscription_id: 1, created_at: now, updated_at: now });
  await assert.rejects(database("schedule_deliveries").insert({ schedule_id: 1, subscription_id: 1, created_at: now, updated_at: now }), /UNIQUE constraint/);
  await database("schedules").where({ id: 1 }).delete();
  assert.equal((await database("schedule_deliveries")).length, 0);
});

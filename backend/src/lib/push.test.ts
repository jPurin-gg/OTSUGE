import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test, { type TestContext } from "node:test";
import knex, { type Knex } from "knex";
import webpush from "web-push";
import { initializeSchema } from "./db-schema";
import { dispatchDueSchedules, sendSchedule } from "./push";

const pushResponse = { statusCode: 201, headers: {}, body: "" };
const execFileAsync = promisify(execFile);

function testPush(context: TestContext, send = async () => pushResponse) {
  const values = {
    NEXT_PUBLIC_VAPID_PUBLIC_KEY: "test-public-key",
    VAPID_PRIVATE_KEY: "test-private-key",
    VAPID_SUBJECT: "mailto:test@example.invalid",
  };
  for (const [name, value] of Object.entries(values)) {
    const previous = process.env[name];
    process.env[name] = value;
    context.after(() => {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    });
  }
  context.mock.method(webpush, "setVapidDetails", () => undefined);
  return context.mock.method(webpush, "sendNotification", send);
}

function connect(filename: string) {
  return knex({ client: "sqlite3", connection: { filename }, useNullAsDefault: true });
}

async function fixture(context: TestContext, minutesAgo = 1, subscriptions = 1) {
  const directory = await mkdtemp(join(tmpdir(), "otsuge-push-"));
  const filename = join(directory, "test.sqlite3");
  const database = connect(filename);
  const other = connect(filename);
  context.after(async () => {
    await Promise.all([database.destroy(), other.destroy()]);
    await rm(directory, { recursive: true, force: true });
  });
  await initializeSchema(database);
  const now = new Date().toISOString();
  await database("notifications").insert({
    id: 1,
    message: "test notification",
    start_time: "00:00",
    end_time: "23:59",
    count_per_day: 1,
    min_interval_minutes: 0,
    enabled: true,
    created_at: now,
    updated_at: now,
  });
  await database("schedules").insert({
    id: 1,
    notification_id: 1,
    scheduled_at: new Date(Date.now() - minutesAgo * 60_000).toISOString(),
    created_at: now,
    updated_at: now,
  });
  if (subscriptions > 0) {
    await database("subscriptions").insert(
      Array.from({ length: subscriptions }, (_, index) => ({
        id: index + 1,
        endpoint: `https://example.invalid/push/${index}`,
        p256dh: "test-p256dh",
        auth: "test-auth",
        created_at: now,
      })),
    );
  }
  return { database, other, filename };
}

async function assertCompleted(database: Knex, status = "sent") {
  const schedule = await database("schedules").where({ id: 1 }).first();
  assert.equal(Boolean(schedule.sent), true);
  assert.equal(Boolean(schedule.discarded), status === "discarded");
  assert.equal(schedule.delivery_lease_token, null);
  assert.equal(schedule.delivery_lease_expires_at, null);
  const logs = await database("delivery_logs").select("*");
  assert.equal(logs.length, 1);
  assert.equal(logs[0].status, status);
}

test("parallel dispatches on independent connections send and log a schedule once", async (context) => {
  const { database, other } = await fixture(context);
  const send = testPush(context);
  const results = await Promise.all([dispatchDueSchedules(database), dispatchDueSchedules(other)]);
  assert.equal(results.reduce((sum, result) => sum + result.processed, 0), 1);
  assert.equal(results.reduce((sum, result) => sum + result.delivered, 0), 1);
  assert.equal(send.mock.callCount(), 1);
  assert.deepEqual(send.mock.calls[0].arguments[2], { timeout: 30_000 });
  await assertCompleted(database);
});

test("dispatch and immediate send share the same claim", async (context) => {
  const { database, other } = await fixture(context);
  const send = testPush(context);
  const [dispatch, immediate] = await Promise.all([
    dispatchDueSchedules(database),
    sendSchedule(other, 1),
  ]);
  assert.equal(dispatch.delivered + (immediate?.delivered ?? 0), 1);
  assert.equal(dispatch.processed + Number(immediate !== null), 1);
  assert.equal(send.mock.callCount(), 1);
  await assertCompleted(database);
});

test("duplicate immediate requests and later requests do not resend", async (context) => {
  const { database, other } = await fixture(context);
  const send = testPush(context);
  const results = await Promise.all([sendSchedule(database, 1), sendSchedule(other, 1)]);
  assert.equal(results.filter((result) => result !== null).length, 1);
  assert.equal(await sendSchedule(database, 1), null);
  assert.equal(send.mock.callCount(), 1);
  await assertCompleted(database);
});

test("a different Node process cannot acquire an in-flight schedule", async (context) => {
  const { database, filename } = await fixture(context);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const send = testPush(context, async () => {
    entered.resolve();
    await release.promise;
    return pushResponse;
  });
  const running = sendSchedule(database, 1);
  await entered.promise;
  try {
    const script = `
      import knex from "knex";
      import webpush from "web-push";
      import { dispatchDueSchedules, sendSchedule } from "./src/lib/push.ts";
      const database = knex({client: "sqlite3", connection: {filename: process.argv[1]}, useNullAsDefault: true});
      let pushes = 0;
      webpush.setVapidDetails = () => {};
      webpush.sendNotification = async () => { pushes++; return {statusCode: 201, headers: {}, body: ""}; };
      try {
        const dispatch = await dispatchDueSchedules(database);
        const immediate = await sendSchedule(database, 1);
        console.log(JSON.stringify({dispatch, immediate, pushes}));
      } finally { await database.destroy(); }
    `;
    const { stdout } = await execFileAsync(process.execPath, [
      "--import", "tsx", "--input-type=module", "--eval", script, filename,
    ], { cwd: process.cwd(), timeout: 15_000 });
    const result = JSON.parse(stdout);
    assert.deepEqual(result, {
      dispatch: { processed: 0, delivered: 0, discarded: 0 },
      immediate: null,
      pushes: 0,
    });
  } finally {
    release.resolve();
    await running;
  }
  assert.equal(send.mock.callCount(), 1);
  await assertCompleted(database);
});

test("active leases prevent dispatch from discarding an immediate send", async (context) => {
  const { database, other } = await fixture(context, 31);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const send = testPush(context, async () => {
    entered.resolve();
    await release.promise;
    return pushResponse;
  });
  const running = sendSchedule(database, 1);
  await entered.promise;
  try {
    assert.deepEqual(await dispatchDueSchedules(other), { processed: 0, delivered: 0, discarded: 0 });
    assert.equal((await database("delivery_logs").select("*")).length, 0);
  } finally {
    release.resolve();
    await running;
  }
  assert.equal(send.mock.callCount(), 1);
  await assertCompleted(database);
});

test("parallel overdue dispatches reclaim an expired lease and discard once", async (context) => {
  const { database, other } = await fixture(context, 31);
  const send = testPush(context);
  await database("schedules").where({ id: 1 }).update({
    delivery_lease_token: "stopped-worker",
    delivery_lease_expires_at: new Date(Date.now() - 1_000).toISOString(),
  });
  const results = await Promise.all([dispatchDueSchedules(database), dispatchDueSchedules(other)]);
  assert.equal(results.reduce((sum, result) => sum + result.discarded, 0), 1);
  assert.equal(send.mock.callCount(), 0);
  assert.equal(await sendSchedule(database, 1), null);
  await assertCompleted(database, "discarded");
});

test("a stopped worker's expired lease can be acquired again", async (context) => {
  const { database, other } = await fixture(context);
  const send = testPush(context);
  await database("schedules").where({ id: 1 }).update({
    delivery_lease_token: "stopped-worker",
    delivery_lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
  });
  assert.equal(await sendSchedule(other, 1), null);
  assert.equal(send.mock.callCount(), 0);
  await database("schedules").where({ id: 1 }).update({
    delivery_lease_expires_at: new Date(Date.now() - 1_000).toISOString(),
  });
  assert.deepEqual(await dispatchDueSchedules(other), { processed: 1, delivered: 1, discarded: 0 });
  assert.equal(send.mock.callCount(), 1);
  await assertCompleted(database);
});

test("a worker that loses its lease stops before the next subscriber", async (context) => {
  const { database, other } = await fixture(context, 1, 2);
  const send = testPush(context, async () => {
    await other("schedules").where({ id: 1 }).update({
      delivery_lease_token: "replacement-worker",
      delivery_lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    return pushResponse;
  });
  await assert.rejects(sendSchedule(database, 1));
  assert.equal(send.mock.callCount(), 1);
  const schedule = await database("schedules").where({ id: 1 }).first();
  assert.equal(Boolean(schedule.sent), false);
  assert.equal(schedule.delivery_lease_token, "replacement-worker");
  assert.equal((await database("delivery_logs").select("*")).length, 0);
});

test("a long delivery renews the same lease before each subscriber", async (context) => {
  const { database, other } = await fixture(context, 1, 2);
  let token: string | undefined;
  let calls = 0;
  testPush(context, async () => {
    const schedule = await other("schedules").where({ id: 1 }).first();
    assert.ok(new Date(schedule.delivery_lease_expires_at).getTime() > Date.now() + 4 * 60_000);
    if (calls === 0) {
      token = schedule.delivery_lease_token;
      await other("schedules").where({ id: 1 }).update({
        delivery_lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
      });
    } else {
      assert.equal(schedule.delivery_lease_token, token);
    }
    calls += 1;
    return pushResponse;
  });
  assert.deepEqual(await sendSchedule(database, 1), { delivered: 2, failed: 0, removed: 0 });
  assert.equal(calls, 2);
  await assertCompleted(database);
});

test("an in-flight Push keeps its lease alive through heartbeats", { timeout: 5_000 }, async (context) => {
  const { database, other } = await fixture(context);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const renewed = Promise.withResolvers<void>();
  context.mock.timers.enable({ apis: ["setInterval"] });
  testPush(context, async () => {
    entered.resolve();
    await release.promise;
    return pushResponse;
  });
  const running = sendSchedule(database, 1);
  await entered.promise;
  try {
    const schedule = await other("schedules").where({ id: 1 }).first();
    await other("schedules").where({ id: 1 }).update({
      delivery_lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    const onResponse = (_result: unknown, query: { sql: string }) => {
      if (query.sql.startsWith("update") && query.sql.includes("delivery_lease_expires_at")) {
        renewed.resolve();
      }
    };
    database.on("query-response", onResponse);
    context.after(() => {
      database.removeListener("query-response", onResponse);
    });
    context.mock.timers.tick(60_000);
    await renewed.promise;
    const active = await other("schedules").where({ id: 1 }).first();
    assert.equal(active.delivery_lease_token, schedule.delivery_lease_token);
    assert.ok(new Date(active.delivery_lease_expires_at).getTime() > Date.now() + 4 * 60_000);
    assert.equal(await sendSchedule(other, 1), null);
  } finally {
    release.resolve();
    await running;
    // Restore real clearInterval before fixture cleanup closes Knex pools that
    // were created before timer mocking started.
    context.mock.timers.reset();
  }
  await assertCompleted(database);
});

test("a failed heartbeat stops delivery even after the database becomes available again", { timeout: 5_000 }, async (context) => {
  const { database, other } = await fixture(context, 1, 2);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const failed = Promise.withResolvers<void>();
  context.mock.timers.enable({ apis: ["setInterval"] });
  const send = testPush(context, async () => {
    entered.resolve();
    await release.promise;
    return pushResponse;
  });
  const running = sendSchedule(database, 1);
  const rejected = assert.rejects(running, /test heartbeat failure/);
  await entered.promise;
  try {
    await other.raw(`CREATE TRIGGER reject_lease_renewal BEFORE UPDATE OF delivery_lease_expires_at ON schedules
      BEGIN SELECT RAISE(ABORT, 'test heartbeat failure'); END`);
    const onError = () => { failed.resolve(); };
    database.on("query-error", onError);
    context.after(() => { database.removeListener("query-error", onError); });
    context.mock.timers.tick(60_000);
    await failed.promise;
    await other.raw("DROP TRIGGER reject_lease_renewal");
  } finally {
    release.resolve();
    await rejected;
    context.mock.timers.reset();
  }
  assert.equal(send.mock.callCount(), 1);
  assert.equal(Boolean((await database("schedules").where({ id: 1 }).first()).sent), false);
  assert.equal((await database("delivery_logs").select("*")).length, 0);
});

test("a stale owner cannot complete or clear the replacement worker's lease", async (context) => {
  const { database, other } = await fixture(context);
  testPush(context, async () => {
    await other("schedules").where({ id: 1 }).update({
      delivery_lease_token: "replacement-worker",
      delivery_lease_expires_at: new Date(Date.now() + 60_000).toISOString(),
    });
    return pushResponse;
  });
  await assert.rejects(sendSchedule(database, 1));
  const schedule = await database("schedules").where({ id: 1 }).first();
  assert.equal(Boolean(schedule.sent), false);
  assert.equal(schedule.delivery_lease_token, "replacement-worker");
  assert.equal((await database("delivery_logs").select("*")).length, 0);
});

test("lease expiry alone prevents a late worker from completing", async (context) => {
  const { database, other } = await fixture(context);
  testPush(context, async () => {
    await other("schedules").where({ id: 1 }).update({
      delivery_lease_expires_at: new Date(Date.now() - 1_000).toISOString(),
    });
    return pushResponse;
  });
  await assert.rejects(sendSchedule(database, 1));
  assert.equal(Boolean((await database("schedules").where({ id: 1 }).first()).sent), false);
  assert.equal((await database("delivery_logs").select("*")).length, 0);
});

test("completion rolls back schedule state when its delivery log cannot be saved", async (context) => {
  const { database } = await fixture(context);
  const send = testPush(context);
  await database.raw(`CREATE TRIGGER reject_delivery_log BEFORE INSERT ON delivery_logs
    BEGIN SELECT RAISE(ABORT, 'test log write failure'); END`);
  await assert.rejects(sendSchedule(database, 1), /test log write failure/);
  assert.equal(send.mock.callCount(), 1);
  const schedule = await database("schedules").where({ id: 1 }).first();
  assert.equal(Boolean(schedule.sent), false);
  assert.ok(schedule.delivery_lease_token);
  assert.equal((await database("delivery_logs").select("*")).length, 0);
});

test("fresh and existing schemas get nullable lease columns without changing schedules", async (context) => {
  const { database } = await fixture(context);
  assert.equal(await database.schema.hasColumn("schedules", "delivery_lease_token"), true);
  assert.equal(await database.schema.hasColumn("schedules", "delivery_lease_expires_at"), true);
  await database.schema.alterTable("schedules", (table) => {
    table.dropColumns("delivery_lease_token", "delivery_lease_expires_at");
  });
  await initializeSchema(database);
  await initializeSchema(database);
  const schedule = await database("schedules").where({ id: 1 }).first();
  assert.equal(Boolean(schedule.sent), false);
  assert.equal(schedule.notification_id, 1);
  assert.equal(schedule.delivery_lease_token, null);
  assert.equal(schedule.delivery_lease_expires_at, null);
});

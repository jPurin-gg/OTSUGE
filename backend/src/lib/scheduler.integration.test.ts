import assert from "node:assert/strict";
import { fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { after, before, beforeEach, test, type TestContext } from "node:test";
import type { Knex } from "knex";
import { generateDailySchedules } from "./scheduler";
import { zonedDateTimeToUtc } from "./time";

const date = "2100-01-01";
const nextDate = "2100-01-02";
const timestamp = "2099-12-31T00:00:00.000Z";
let directory: string;
let filename: string;
let database: Knex;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "otsuge-generation-"));
  filename = join(directory, "schedules.sqlite3");
  const previous = { DB_CLIENT: process.env.DB_CLIENT, SQLITE_PATH: process.env.SQLITE_PATH };
  process.env.DB_CLIENT = "sqlite";
  process.env.SQLITE_PATH = filename;
  try {
    const { readyDb } = await import("./db");
    database = await readyDb();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

after(async () => {
  await database?.destroy();
  if (directory) await rm(directory, { recursive: true, force: true });
});

beforeEach(async () => {
  await database("delivery_logs").delete();
  await database("schedules").delete();
  await database("notifications").delete();
  await database("quiet_hours").delete();
  await database("schedule_generation_locks").delete();
});

async function addNotification(message = "test") {
  const [id] = await database("notifications").insert({
    message,
    start_time: "09:00",
    end_time: "11:00",
    count_per_day: 2,
    min_interval_minutes: 30,
    enabled: true,
    created_at: timestamp,
    updated_at: timestamp,
  });
  return id as number;
}

function schedule(notificationId: number, time: string, day = date, extra = {}) {
  return {
    notification_id: notificationId,
    scheduled_at: zonedDateTimeToUtc(day, time).toISOString(),
    sent: false,
    discarded: false,
    manually_modified: false,
    created_at: timestamp,
    updated_at: timestamp,
    ...extra,
  };
}

type WorkerMessage = {
  type: string;
  error?: string;
  result?: { generated: number; warnings: string[]; date: string };
};

function startWorker(t: TestContext, role: "holder" | "follower") {
  const child = fork(fileURLToPath(new URL("./scheduler-test-worker.ts", import.meta.url)), [date, role], {
    execArgv: ["--import", "tsx"],
    env: { ...process.env, DB_CLIENT: "sqlite", SQLITE_PATH: filename },
    silent: true,
  });
  const messages: WorkerMessage[] = [];
  const waiters = new Set<() => void>();
  let output = "";
  let exited = false;
  child.stdout?.on("data", (data) => { output += data; });
  child.stderr?.on("data", (data) => { output += data; });
  child.on("message", (message: WorkerMessage) => {
    messages.push(message);
    for (const notify of waiters) notify();
  });
  const finished = new Promise<number | null>((resolve) => {
    child.on("close", (code) => {
      exited = true;
      for (const notify of waiters) notify();
      resolve(code);
    });
  });
  child.on("error", (error) => {
    messages.push({ type: "error", error: String(error) });
    for (const notify of waiters) notify();
  });
  t.after(async () => {
    if (!exited) child.kill();
    await finished;
  });

  async function waitFor(type: string) {
    return new Promise<WorkerMessage>((resolve, reject) => {
      const timer = globalThis.setTimeout(() => {
        waiters.delete(check);
        reject(new Error(`Worker did not reach ${type}: ${output}`));
      }, 10_000);
      function check() {
        const message = messages.find((value) => value.type === type);
        const error = messages.find((value) => value.type === "error");
        if (message || error || exited) {
          globalThis.clearTimeout(timer);
          waiters.delete(check);
          if (message) resolve(message);
          else reject(new Error(error?.error ?? `Worker exited before ${type}: ${output}`));
        }
      }
      waiters.add(check);
      check();
    });
  }
  return { child, messages, waitFor, finished };
}

test("concurrent requests on one backend leave only one generation", async () => {
  await addNotification();
  const results = await Promise.all([
    generateDailySchedules(database, date),
    generateDailySchedules(database, date),
  ]);
  assert.deepEqual(results.map((result) => result.generated), [2, 2]);
  assert.equal((await database("schedules")).length, 2);
});

for (const existingLock of [false, true]) {
  test(`separate processes serialize ${existingLock ? "an existing" : "a new"} date lock with different random times`, async (t) => {
    await addNotification();
    if (existingLock) await database("schedule_generation_locks").insert({ date });

    const holder = startWorker(t, "holder");
    await holder.waitFor("paused");
    const follower = startWorker(t, "follower");
    await follower.waitFor("lock-attempt");
    // The first process is paused inside its transaction. A second process must
    // wait before reading inputs, even when a lock row did not exist beforehand.
    await setTimeout(100);
    assert.equal(follower.messages.some((message) => message.type === "read"), false);
    assert.equal(follower.messages.some((message) => message.type === "result"), false);
    holder.child.send("release");
    const [first, second] = await Promise.all([holder.waitFor("result"), follower.waitFor("result")]);
    assert.equal(first.result?.generated, 2);
    assert.equal(second.result?.generated, 2);
    assert.deepEqual(await Promise.all([holder.finished, follower.finished]), [0, 0]);

    const rows = await database("schedules").orderBy("scheduled_at");
    assert.deepEqual(rows.map((row) => row.scheduled_at), [
      zonedDateTimeToUtc(date, "10:30").toISOString(),
      zonedDateTimeToUtc(date, "11:00").toISOString(),
    ]);
    assert.deepEqual(await database("schedule_generation_locks").select("date"), [{ date }]);
  });
}

test("a later insertion failure restores all original schedules and rolls back partial generation", async () => {
  const first = await addNotification("first");
  const second = await addNotification("second");
  await database("schedules").insert([
    schedule(first, "08:00"),
    schedule(second, "08:30"),
    schedule(first, "09:00", date, { sent: true }),
    schedule(second, "09:30", date, { manually_modified: true }),
    schedule(first, "10:00", nextDate),
  ]);
  const original = await database("schedules").orderBy("id");
  await database.raw(`CREATE TRIGGER fail_second_generation BEFORE INSERT ON schedules
    WHEN NEW.notification_id = ${second}
    BEGIN SELECT RAISE(ABORT, 'injected insertion failure'); END`);
  let successfulInserts = 0;
  const onResponse = (_response: unknown, query: { sql: string }) => {
    if (query.sql.startsWith("insert into `schedules`")) successfulInserts += 1;
  };
  database.on("query-response", onResponse);
  try {
    await assert.rejects(generateDailySchedules(database, date), /injected insertion failure/);
  } finally {
    database.off("query-response", onResponse);
    await database.raw("DROP TRIGGER fail_second_generation");
  }
  assert.equal(successfulInserts, 1, "failure occurs after the first notification was inserted");
  assert.deepEqual(await database("schedules").orderBy("id"), original);
  assert.deepEqual(await database("schedule_generation_locks"), []);

  assert.equal((await generateDailySchedules(database, date)).generated, 4);
});

test("successful regeneration preserves sent, manually modified and other-day schedules", async () => {
  const notification = await addNotification();
  await database("schedules").insert([
    schedule(notification, "08:00"),
    schedule(notification, "08:30", date, { sent: true }),
    schedule(notification, "09:00", date, { manually_modified: true }),
    schedule(notification, "09:30", nextDate),
  ]);
  const original = await database("schedules").orderBy("id");
  await generateDailySchedules(database, date);
  const rows = await database("schedules").orderBy("id");
  assert.deepEqual(rows.filter((row) => original.some((old) => old.id === row.id)), original.slice(1));
  assert.equal(rows.length, 5);

  await generateDailySchedules(database, nextDate);
  const dateRows = rows.filter((row) => row.id !== original[3].id);
  assert.deepEqual(await database("schedules").whereIn("id", dateRows.map((row) => row.id)).orderBy("id"), dateRows);
  assert.deepEqual(await database("schedule_generation_locks").orderBy("date"), [{ date }, { date: nextDate }]);
});

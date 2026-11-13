import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import type { Knex } from "knex";

let database: Knex;
let directory: string;

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "otsuge-cascade-"));
  process.env.DB_CLIENT = "sqlite";
  process.env.SQLITE_PATH = join(directory, "test.sqlite3");
  const { readyDb } = await import("./db");
  database = await readyDb();
});

after(async () => {
  await database?.destroy();
  if (directory) await rm(directory, { recursive: true, force: true });
});

beforeEach(async () => {
  await database("delivery_logs").delete();
  await database("schedules").delete();
  await database("notifications").delete();
});

test("deleting a SQLite notification cascades only its schedules and preserves delivery logs", async () => {
  const now = new Date().toISOString();
  await database("notifications").insert(
    [1, 2].map((id) => ({
      id,
      message: `Notification ${id}`,
      start_time: "09:00",
      end_time: "22:00",
      count_per_day: 2,
      min_interval_minutes: 60,
      created_at: now,
      updated_at: now,
    })),
  );
  await database("schedules").insert(
    [1, 1, 2].map((notification_id, index) => ({
      id: index + 1,
      notification_id,
      scheduled_at: now,
      created_at: now,
      updated_at: now,
    })),
  );
  await database("delivery_logs").insert({
    schedule_id: 1,
    status: "sent",
    message: "Notification 1",
    scheduled_at: now,
    sent_at: now,
    created_at: now,
  });

  await database("notifications").where({ id: 1 }).delete();

  assert.deepEqual(await database("schedules").select("id", "notification_id"), [
    { id: 3, notification_id: 2 },
  ]);
  assert.deepEqual(await database("notifications").select("id"), [{ id: 2 }]);
  assert.equal((await database("delivery_logs").first()).schedule_id, null);
});

test("SQLite foreign keys are enabled again when the connection pool is recreated", async () => {
  assert.deepEqual(await database.raw("PRAGMA foreign_keys"), [{ foreign_keys: 1 }]);
  await database.destroy();
  database.initialize();
  assert.deepEqual(await database.raw("PRAGMA foreign_keys"), [{ foreign_keys: 1 }]);

  const now = new Date().toISOString();
  await assert.rejects(
    database("schedules").insert({
      notification_id: 999,
      scheduled_at: now,
      created_at: now,
      updated_at: now,
    }),
    /FOREIGN KEY constraint failed/,
  );
});

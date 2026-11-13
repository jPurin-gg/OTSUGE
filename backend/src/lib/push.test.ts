import assert from "node:assert/strict";
import { after, before, test } from "node:test";
import type { Knex } from "knex";
import webpush from "web-push";
import { dispatchDueSchedules } from "./push";

let database: Knex;

before(async () => {
  process.env.DB_CLIENT = "sqlite";
  process.env.SQLITE_PATH = ":memory:";
  const { readyDb } = await import("./db");
  database = await readyDb();
});

after(async () => {
  await database?.destroy();
});

test("dispatch skips legacy orphan schedules and continues processing valid schedules", async () => {
  const now = new Date();
  const timestamp = now.toISOString();
  await database("notifications").insert({
    id: 1,
    message: "Valid notification",
    start_time: "00:00",
    end_time: "23:59",
    count_per_day: 1,
    min_interval_minutes: 60,
    created_at: timestamp,
    updated_at: timestamp,
  });

  // Simulate records left behind before SQLite foreign keys were enabled.
  await database.raw("PRAGMA foreign_keys = OFF");
  try {
    await database("schedules").insert(
      [
        { id: 1, notification_id: 999, age: 60_000 },
        { id: 2, notification_id: 1, age: 60_000 },
        { id: 3, notification_id: 999, age: 31 * 60_000 },
        { id: 4, notification_id: 1, age: 31 * 60_000 },
        { id: 5, notification_id: 1, age: -60 * 60_000 },
      ].map(({ age, ...schedule }) => ({
        ...schedule,
        scheduled_at: new Date(now.getTime() - age).toISOString(),
        created_at: timestamp,
        updated_at: timestamp,
      })),
    );
  } finally {
    await database.raw("PRAGMA foreign_keys = ON");
  }

  const keys = webpush.generateVAPIDKeys();
  process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY = keys.publicKey;
  process.env.VAPID_PRIVATE_KEY = keys.privateKey;
  process.env.VAPID_SUBJECT = "mailto:test@example.com";

  assert.deepEqual(await dispatchDueSchedules(database), { processed: 1, delivered: 0, discarded: 1 });
  assert.deepEqual(await database("schedules").select("id", "sent", "discarded").orderBy("id"), [
    { id: 1, sent: 0, discarded: 0 },
    { id: 2, sent: 1, discarded: 0 },
    { id: 3, sent: 0, discarded: 0 },
    { id: 4, sent: 1, discarded: 1 },
    { id: 5, sent: 0, discarded: 0 },
  ]);
  assert.deepEqual(await database("delivery_logs").select("schedule_id", "status").orderBy("schedule_id"), [
    { schedule_id: 2, status: "sent" },
    { schedule_id: 4, status: "discarded" },
  ]);

  delete process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  delete process.env.VAPID_PRIVATE_KEY;
  delete process.env.VAPID_SUBJECT;
  assert.deepEqual(await dispatchDueSchedules(database), { processed: 0, delivered: 0, discarded: 0 });
});

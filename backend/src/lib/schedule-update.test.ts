import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import type { Knex } from "knex";
import { updateScheduleTime } from "./schedule-update";

process.env.SQLITE_PATH = ":memory:";
process.env.APP_TIMEZONE = "Asia/Tokyo";

const CREATED_AT = "2026-11-13T15:00:00.000Z";
// 2026-11-14 09:42 JST
const SCHEDULED_AT = "2026-11-14T00:42:00.000Z";

let database: Knex;
let notificationId: number;

before(async () => {
  // db.ts は読み込み時に接続先を決めるので、環境変数を設定してから読み込む。
  const { readyDb } = await import("./db");
  database = await readyDb();
  [notificationId] = await database("notifications").insert({
    message: "水を飲め",
    start_time: "09:00",
    end_time: "22:00",
    count_per_day: 1,
    min_interval_minutes: 60,
    enabled: true,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
  });
});

beforeEach(async () => {
  await database("schedules").delete();
});

after(async () => {
  await database.destroy();
});

async function insertSchedule(overrides: Record<string, unknown> = {}) {
  const [id] = await database("schedules").insert({
    notification_id: notificationId,
    scheduled_at: SCHEDULED_AT,
    sent: false,
    discarded: false,
    manually_modified: false,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
    ...overrides,
  });
  return id as number;
}

async function readSchedule(id: number) {
  const row = await database("schedules").where({ id }).first();
  return {
    scheduled_at: new Date(row.scheduled_at).toISOString(),
    manually_modified: Boolean(row.manually_modified),
    updated_at: new Date(row.updated_at).toISOString(),
  };
}

const untouched = { scheduled_at: SCHEDULED_AT, manually_modified: false, updated_at: CREATED_AT };

test("同じ時刻を送っても手動編集にならず、何も書き換えない", async () => {
  const id = await insertSchedule();
  assert.equal(await updateScheduleTime(database, id, SCHEDULED_AT), "unchanged");
  assert.deepEqual(await readSchedule(id), untouched);
});

test("表記が違っても同じ時刻なら変更なしとして扱う", async () => {
  const id = await insertSchedule();
  assert.equal(await updateScheduleTime(database, id, "2026-11-14T00:42:00Z"), "unchanged");
  assert.deepEqual(await readSchedule(id), untouched);
});

test("時刻が変わったときだけ手動編集にする", async () => {
  const id = await insertSchedule();
  assert.equal(await updateScheduleTime(database, id, "2026-11-14T04:18:00Z"), "updated");
  const row = await readSchedule(id);
  assert.equal(row.scheduled_at, "2026-11-14T04:18:00.000Z");
  assert.equal(row.manually_modified, true);
  assert.notEqual(row.updated_at, CREATED_AT);
});

test("すでに手動編集の予定に同じ時刻を送っても手動編集のまま変わらない", async () => {
  const id = await insertSchedule({ manually_modified: true });
  assert.equal(await updateScheduleTime(database, id, SCHEDULED_AT), "unchanged");
  assert.deepEqual(await readSchedule(id), { ...untouched, manually_modified: true });
});

test("送信済みの予定は時刻を変更できない", async () => {
  const id = await insertSchedule({ sent: true });
  assert.equal(await updateScheduleTime(database, id, "2026-11-14T04:18:00.000Z"), "locked");
  assert.deepEqual(await readSchedule(id), untouched);
});

test("破棄済みの予定は時刻を変更できない", async () => {
  const id = await insertSchedule({ sent: true, discarded: true });
  assert.equal(await updateScheduleTime(database, id, "2026-11-14T04:18:00.000Z"), "locked");
  assert.deepEqual(await readSchedule(id), untouched);
});

test("予定と別の日になる時刻には変更できない", async () => {
  const id = await insertSchedule();
  // 2026-11-15 00:00 JST（翌日の最初）と 2026-11-13 23:59 JST（前日の最後）
  assert.equal(await updateScheduleTime(database, id, "2026-11-14T15:00:00.000Z"), "other_day");
  assert.equal(await updateScheduleTime(database, id, "2026-11-13T14:59:00.000Z"), "other_day");
  assert.deepEqual(await readSchedule(id), untouched);
});

test("同じ日の最初と最後の分には変更できる", async () => {
  const first = await insertSchedule();
  assert.equal(await updateScheduleTime(database, first, "2026-11-13T15:00:00.000Z"), "updated");
  const last = await insertSchedule();
  assert.equal(await updateScheduleTime(database, last, "2026-11-14T14:59:00.000Z"), "updated");
});

test("存在しない予定や不正な id は not_found", async () => {
  assert.equal(await updateScheduleTime(database, 999_999, SCHEDULED_AT), "not_found");
  assert.equal(await updateScheduleTime(database, Number("abc"), SCHEDULED_AT), "not_found");
});

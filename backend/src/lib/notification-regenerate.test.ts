import assert from "node:assert/strict";
import test, { after, before, beforeEach, mock } from "node:test";
import type { Knex } from "knex";
import { NOW, TODAY, adminRequest, insertNotification, insertSchedule, minutesFromNow, openTestDatabase, routeContext } from "./test-support";
import { localMinuteOfDay } from "./time";

// 「設定を保存した後、そのお告げだけ当日の予定を引き直せる」ことを確かめる（issue #17）。

mock.timers.enable({ apis: ["Date"], now: NOW });

let database: Knex;
let scheduler: typeof import("./scheduler");
let route: typeof import("../app/api/admin/notifications/[id]/schedules/route");

before(async () => {
  database = await openTestDatabase();
  scheduler = await import("./scheduler");
  route = await import("../app/api/admin/notifications/[id]/schedules/route");
});

beforeEach(async () => {
  await database("schedules").delete();
  await database("notifications").delete();
  await database("quiet_hours").delete();
});

after(async () => {
  await database.destroy();
});

async function scheduleIds(notificationId: number) {
  const rows = await database("schedules").where({ notification_id: notificationId }).orderBy("id").select("id");
  return rows.map((row) => row.id as number);
}

async function scheduledMinutes(ids: number[]) {
  const rows = await database("schedules").whereIn("id", ids).select("scheduled_at");
  return rows.map((row) => localMinuteOfDay(new Date(row.scheduled_at)));
}

test("対象のお告げの未送信の予定だけを、現在の設定で作り直す", async () => {
  // 予定を生成した後で、時間帯と回数を変えた状態。
  const targetId = await insertNotification(database, {
    start_time: "15:00",
    end_time: "18:00",
    count_per_day: 3,
    min_interval_minutes: 30,
  });
  const otherId = await insertNotification(database, { message: "姿勢を正せ" });
  const stale = await insertSchedule(database, targetId, { scheduled_at: minutesFromNow(60) });
  const sent = await insertSchedule(database, targetId, { scheduled_at: minutesFromNow(-120), sent: true });
  const manual = await insertSchedule(database, targetId, { scheduled_at: minutesFromNow(90), manually_modified: true });
  const other = await insertSchedule(database, otherId, { scheduled_at: minutesFromNow(60) });

  const result = await scheduler.regenerateNotificationSchedules(database, targetId);

  assert.deepEqual(result, { generated: 3, removed: 1, warnings: [], date: TODAY });
  const ids = await scheduleIds(targetId);
  assert.ok(!ids.includes(stale), "古い未送信の予定は削除する");
  assert.ok(ids.includes(sent) && ids.includes(manual), "送信済みと手動編集の予定は残す");
  const created = ids.filter((id) => id !== sent && id !== manual);
  assert.equal(created.length, 3);
  const minutes = (await scheduledMinutes(created)).sort((a, b) => a - b);
  assert.ok(minutes.every((minute) => minute >= 15 * 60 && minute <= 18 * 60), "新しい時間帯の中に生成する");
  assert.ok(minutes.slice(1).every((minute, index) => minute - minutes[index] >= 30), "最低間隔を守る");
  assert.deepEqual(await scheduleIds(otherId), [other], "ほかのお告げの予定には触れない");
});

test("当日の引き直しは、現在時刻より後にだけ生成する", async () => {
  // NOW は 12:00。開始 09:00 でも、過ぎた時刻には生成しない。
  const id = await insertNotification(database, { start_time: "09:00", end_time: "22:00", count_per_day: 5 });

  const result = await scheduler.regenerateNotificationSchedules(database, id);

  assert.equal(result?.generated, 5);
  const minutes = await scheduledMinutes(await scheduleIds(id));
  assert.ok(minutes.every((minute) => minute > 12 * 60));
});

test("静かにする時間を避け、足りない分は警告として返す", async () => {
  const id = await insertNotification(database, {
    message: "研究を進めろ",
    start_time: "13:00",
    end_time: "14:00",
    count_per_day: 3,
    min_interval_minutes: 30,
  });
  await database("quiet_hours").insert({
    start_time: "13:00",
    end_time: "13:45",
    enabled: true,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  });

  const result = await scheduler.regenerateNotificationSchedules(database, id);

  assert.equal(result?.generated, 1);
  assert.deepEqual(result?.warnings, ["「研究を進めろ」は条件内で1件のみ生成しました。"]);
  const minutes = await scheduledMinutes(await scheduleIds(id));
  assert.ok(minutes.every((minute) => minute >= 13 * 60 + 45 && minute <= 14 * 60));
});

test("無効なお告げは、未送信の予定を削除するだけで新しく生成しない", async () => {
  const id = await insertNotification(database, { enabled: false });
  await insertSchedule(database, id, { scheduled_at: minutesFromNow(60) });

  const result = await scheduler.regenerateNotificationSchedules(database, id);

  assert.equal(result?.generated, 0);
  assert.equal(result?.removed, 1);
  assert.equal(result?.warnings.length, 1);
  assert.deepEqual(await scheduleIds(id), []);
});

test("存在しないお告げには null を返す", async () => {
  assert.equal(await scheduler.regenerateNotificationSchedules(database, 9999), null);
});

test("引き直しの API は、生成した件数と削除した件数を返す", async () => {
  const id = await insertNotification(database, { start_time: "15:00", end_time: "18:00", count_per_day: 2 });
  await insertSchedule(database, id, { scheduled_at: minutesFromNow(60) });

  const response = await route.POST(
    adminRequest(`/api/admin/notifications/${id}/schedules`, { method: "POST" }),
    routeContext(id),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { generated: 2, removed: 1, warnings: [], date: TODAY });
  assert.equal((await scheduleIds(id)).length, 2);
});

test("引き直しの API は、存在しないお告げと不正な ID に 404 を返す", async () => {
  for (const id of ["9999", "abc"]) {
    const response = await route.POST(
      adminRequest(`/api/admin/notifications/${id}/schedules`, { method: "POST" }),
      routeContext(id),
    );
    assert.equal(response.status, 404, id);
  }
});

test("引き直しの API は、ログインしていなければ 401 を返す", async () => {
  const id = await insertNotification(database);
  const { NextRequest } = await import("next/server");

  const response = await route.POST(
    new NextRequest(`http://localhost/api/admin/notifications/${id}/schedules`, { method: "POST" }),
    routeContext(id),
  );

  assert.equal(response.status, 401);
});

import assert from "node:assert/strict";
import test, { after, before, beforeEach, mock } from "node:test";
import type { Knex } from "knex";
import webpush from "web-push";
import { NOW, adminRequest, insertNotification, insertSchedule, minutesFromNow, openTestDatabase, routeContext } from "./test-support";

// 「無効にしたお告げは、当日の未送信分も送らない」ことを確かめる（issue #17）。

const SUBSCRIPTION_COUNT = 2;

// 実際の Push サービスへは送らない。呼ばれた回数で「送ったかどうか」を確かめる。
mock.method(webpush, "setVapidDetails", () => undefined);
const sendNotification = mock.method(webpush, "sendNotification", async () => ({
  statusCode: 201,
  headers: {},
  body: "",
}));
mock.timers.enable({ apis: ["Date"], now: NOW });

let database: Knex;
let push: typeof import("./push");
let sendRoute: typeof import("../app/api/admin/schedules/[id]/send/route");
let publicRoute: typeof import("../app/api/public/schedules/route");

before(async () => {
  database = await openTestDatabase();
  push = await import("./push");
  sendRoute = await import("../app/api/admin/schedules/[id]/send/route");
  publicRoute = await import("../app/api/public/schedules/route");
  await database("subscriptions").insert(
    Array.from({ length: SUBSCRIPTION_COUNT }, (_, index) => ({
      endpoint: `https://example.invalid/push/${index}`,
      p256dh: "test-p256dh",
      auth: "test-auth",
      created_at: NOW.toISOString(),
    })),
  );
});

beforeEach(async () => {
  await database("delivery_logs").delete();
  await database("schedules").delete();
  await database("notifications").delete();
  sendNotification.mock.resetCalls();
});

after(async () => {
  await database.destroy();
});

async function scheduleState(id: number) {
  const row = await database("schedules").where({ id }).first();
  return { sent: Boolean(row.sent), discarded: Boolean(row.discarded) };
}

async function setEnabled(notificationId: number, enabled: boolean) {
  await database("notifications").where({ id: notificationId }).update({ enabled });
}

async function publicMessages() {
  const response = await publicRoute.GET();
  const body = (await response.json()) as { schedules: { message: string; sent: boolean | number }[] };
  return body.schedules.map((schedule) => schedule.message);
}

test("自動送信は、無効にしたお告げの予定を送らず、有効なお告げの予定だけ送る", async () => {
  const disabledId = await insertNotification(database, { message: "止めたお告げ" });
  const enabledId = await insertNotification(database, { message: "続けるお告げ" });
  const stopped = await insertSchedule(database, disabledId, { scheduled_at: minutesFromNow(-1) });
  const kept = await insertSchedule(database, enabledId, { scheduled_at: minutesFromNow(-1) });
  // 予定を生成した後で無効にする。
  await setEnabled(disabledId, false);

  const result = await push.dispatchDueSchedules(database);

  assert.equal(result.processed, 1);
  assert.equal(sendNotification.mock.callCount(), SUBSCRIPTION_COUNT);
  assert.deepEqual(await scheduleState(stopped), { sent: false, discarded: false });
  assert.deepEqual(await scheduleState(kept), { sent: true, discarded: false });
  const logs = await database("delivery_logs").select("message");
  assert.deepEqual(logs.map((log) => log.message), ["続けるお告げ"]);
});

test("無効にしたお告げを有効に戻すと、まだ間に合う予定は送られる", async () => {
  const notificationId = await insertNotification(database, { enabled: false });
  const scheduleId = await insertSchedule(database, notificationId, { scheduled_at: minutesFromNow(-5) });

  await push.dispatchDueSchedules(database);
  assert.equal(sendNotification.mock.callCount(), 0);

  await setEnabled(notificationId, true);
  const result = await push.dispatchDueSchedules(database);

  assert.equal(result.processed, 1);
  assert.equal(sendNotification.mock.callCount(), SUBSCRIPTION_COUNT);
  assert.deepEqual(await scheduleState(scheduleId), { sent: true, discarded: false });
});

test("無効なお告げの予定は、予定時刻から30分たつと送られないまま破棄される", async () => {
  const notificationId = await insertNotification(database, { enabled: false });
  const scheduleId = await insertSchedule(database, notificationId, { scheduled_at: minutesFromNow(-31) });

  const result = await push.dispatchDueSchedules(database);

  assert.equal(result.discarded, 1);
  assert.equal(sendNotification.mock.callCount(), 0);
  assert.deepEqual(await scheduleState(scheduleId), { sent: true, discarded: true });
});

test("sendSchedule は無効なお告げの予定を送らず、予定を未送信のまま残す", async () => {
  const notificationId = await insertNotification(database, { enabled: false });
  const scheduleId = await insertSchedule(database, notificationId);

  await assert.rejects(push.sendSchedule(database, scheduleId), { name: "NotificationDisabledError" });

  assert.equal(sendNotification.mock.callCount(), 0);
  assert.deepEqual(await scheduleState(scheduleId), { sent: false, discarded: false });
  assert.equal((await database("delivery_logs").select("id")).length, 0);
});

test("即時送信の API は、無効なお告げの予定を 409 で断り、理由を返す", async () => {
  const notificationId = await insertNotification(database, { enabled: false });
  const scheduleId = await insertSchedule(database, notificationId);

  const response = await sendRoute.POST(
    adminRequest(`/api/admin/schedules/${scheduleId}/send`, { method: "POST" }),
    routeContext(scheduleId),
  );

  assert.equal(response.status, 409);
  assert.match(((await response.json()) as { error: string }).error, /無効/);
  assert.equal(sendNotification.mock.callCount(), 0);
  assert.deepEqual(await scheduleState(scheduleId), { sent: false, discarded: false });
});

test("即時送信の API は、有効なお告げの予定をこれまでどおり送る", async () => {
  const notificationId = await insertNotification(database);
  const scheduleId = await insertSchedule(database, notificationId);

  const response = await sendRoute.POST(
    adminRequest(`/api/admin/schedules/${scheduleId}/send`, { method: "POST" }),
    routeContext(scheduleId),
  );

  assert.equal(response.status, 200);
  assert.equal(((await response.json()) as { delivered: number }).delivered, SUBSCRIPTION_COUNT);
  assert.deepEqual(await scheduleState(scheduleId), { sent: true, discarded: false });
});

test("利用者向けの一覧は、無効なお告げの届かない予定（未送信・破棄）を出さない", async () => {
  const disabledId = await insertNotification(database, { message: "止めたお告げ", enabled: false });
  const enabledId = await insertNotification(database, { message: "続けるお告げ" });
  await insertSchedule(database, disabledId, { scheduled_at: minutesFromNow(60) });
  await insertSchedule(database, disabledId, { scheduled_at: minutesFromNow(-90), sent: true, discarded: true });
  await insertSchedule(database, enabledId, { scheduled_at: minutesFromNow(30) });
  await insertSchedule(database, enabledId, { scheduled_at: minutesFromNow(-90), sent: true, discarded: true });

  assert.deepEqual(await publicMessages(), ["続けるお告げ", "続けるお告げ"]);
});

test("利用者向けの一覧は、無効にする前に届いた分を残す", async () => {
  const disabledId = await insertNotification(database, { message: "止めたお告げ", enabled: false });
  await insertSchedule(database, disabledId, { scheduled_at: minutesFromNow(-120), sent: true });
  await insertSchedule(database, disabledId, { scheduled_at: minutesFromNow(60) });

  assert.deepEqual(await publicMessages(), ["止めたお告げ"]);
});

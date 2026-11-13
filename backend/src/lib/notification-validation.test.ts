import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import type { Knex } from "knex";
import { chooseMinutes } from "./scheduler";
import { adminRequest, insertNotification, openTestDatabase, routeContext } from "./test-support";
import { notificationInput } from "./validation";

// 「開始が終了より後のお告げは保存時にエラーになる」ことを確かめる（issue #17）。

const base = { message: "水を飲め", count_per_day: 1, min_interval_minutes: 60, enabled: true };

let database: Knex;
let collectionRoute: typeof import("../app/api/admin/notifications/route");
let itemRoute: typeof import("../app/api/admin/notifications/[id]/route");

before(async () => {
  database = await openTestDatabase();
  collectionRoute = await import("../app/api/admin/notifications/route");
  itemRoute = await import("../app/api/admin/notifications/[id]/route");
});

beforeEach(async () => {
  await database("notifications").delete();
});

after(async () => {
  await database.destroy();
});

test("開始が終了より後の時間帯は検証で弾く", () => {
  for (const [start_time, end_time] of [
    ["22:00", "06:00"],
    ["09:01", "09:00"],
    ["23:59", "00:01"],
  ]) {
    const result = notificationInput.safeParse({ ...base, start_time, end_time });
    assert.equal(result.success, false, `${start_time}-${end_time}`);
  }
});

test("開始が終了以前の時間帯と、終了 00:00（23:59 まで）は検証を通る", () => {
  for (const [start_time, end_time] of [
    ["09:00", "22:00"],
    ["09:00", "09:00"],
    ["22:00", "00:00"],
    ["23:59", "00:00"],
    ["00:00", "00:00"],
  ]) {
    const result = notificationInput.safeParse({ ...base, start_time, end_time });
    assert.equal(result.success, true, `${start_time}-${end_time}`);
  }
});

test("検証の結果は「1件以上生成できる時間帯かどうか」と一致する", () => {
  const times = ["00:00", "00:01", "06:00", "09:00", "12:30", "22:00", "23:59"];
  for (const start_time of times) {
    for (const end_time of times) {
      const accepted = notificationInput.safeParse({ ...base, start_time, end_time }).success;
      const generated = chooseMinutes({ ...base, start_time, end_time }, [], () => 0.5).length;
      assert.equal(accepted, generated > 0, `${start_time}-${end_time}`);
    }
  }
});

test("作成の API は、開始が終了より後のお告げを 400 で断り、保存しない", async () => {
  const response = await collectionRoute.POST(
    adminRequest("/api/admin/notifications", {
      method: "POST",
      body: { ...base, start_time: "22:00", end_time: "06:00" },
    }),
  );

  assert.equal(response.status, 400);
  assert.match(((await response.json()) as { error: string }).error, /開始は終了より前/);
  assert.equal((await database("notifications").select("id")).length, 0);
});

test("更新の API は、開始が終了より後のお告げを 400 で断り、元の設定を変えない", async () => {
  const id = await insertNotification(database, { start_time: "09:00", end_time: "22:00" });

  const response = await itemRoute.PUT(
    adminRequest(`/api/admin/notifications/${id}`, {
      method: "PUT",
      body: { ...base, start_time: "22:00", end_time: "06:00" },
    }),
    routeContext(id),
  );

  assert.equal(response.status, 400);
  assert.match(((await response.json()) as { error: string }).error, /開始は終了より前/);
  const row = await database("notifications").where({ id }).first();
  assert.deepEqual([row.start_time, row.end_time], ["09:00", "22:00"]);
});

test("作成の API は、終了 00:00 のお告げを保存できる", async () => {
  const response = await collectionRoute.POST(
    adminRequest("/api/admin/notifications", {
      method: "POST",
      body: { ...base, start_time: "22:00", end_time: "00:00" },
    }),
  );

  assert.equal(response.status, 201);
  assert.equal((await database("notifications").select("id")).length, 1);
});

test("ほかの入力エラーには、時間帯の説明を付けない", async () => {
  const response = await collectionRoute.POST(
    adminRequest("/api/admin/notifications", {
      method: "POST",
      body: { ...base, message: "", start_time: "09:00", end_time: "22:00" },
    }),
  );

  assert.equal(response.status, 400);
  assert.equal(((await response.json()) as { error: string }).error, "入力内容が不正です。");
});

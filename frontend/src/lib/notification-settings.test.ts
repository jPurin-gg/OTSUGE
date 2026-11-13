import assert from "node:assert/strict";
import test from "node:test";
import {
  allDayQuietHoursConfirmText,
  isAllDayQuietHours,
  notificationTimeError,
  todayStatus,
} from "./notification-settings";

const item = {
  id: 1,
  message: "水を飲め",
  start_time: "09:00",
  end_time: "22:00",
  count_per_day: 3,
  min_interval_minutes: 60,
  enabled: true,
};

function schedule(values: Partial<{ notification_id: number; sent: boolean; manually_modified: boolean }> = {}) {
  return { notification_id: 1, sent: false, manually_modified: false, ...values };
}

test("開始が終了より後の時間帯は、保存できない理由を返す", () => {
  for (const [start_time, end_time] of [
    ["22:00", "06:00"],
    ["09:01", "09:00"],
    ["23:59", "00:01"],
  ]) {
    assert.match(notificationTimeError({ start_time, end_time }) ?? "", /開始は終了より前/, `${start_time}-${end_time}`);
  }
});

test("開始が終了以前の時間帯と、終了 00:00（23:59 まで）は保存できる", () => {
  for (const [start_time, end_time] of [
    ["09:00", "22:00"],
    ["09:00", "09:00"],
    ["22:00", "00:00"],
    ["23:59", "00:00"],
    ["00:00", "00:00"],
  ]) {
    assert.equal(notificationTimeError({ start_time, end_time }), null, `${start_time}-${end_time}`);
  }
});

test("時刻が空なら保存できない", () => {
  assert.notEqual(notificationTimeError({ start_time: "", end_time: "22:00" }), null);
  assert.notEqual(notificationTimeError({ start_time: "09:00", end_time: "" }), null);
});

test("開始と終了が同じ「静かにする時間」は終日として扱い、確認文で終日になることを伝える", () => {
  assert.equal(isAllDayQuietHours({ start_time: "08:00", end_time: "08:00" }), true);
  assert.equal(isAllDayQuietHours({ start_time: "00:00", end_time: "00:00" }), true);
  assert.equal(isAllDayQuietHours({ start_time: "22:00", end_time: "08:00" }), false);
  assert.equal(isAllDayQuietHours({ start_time: "", end_time: "" }), false);

  const text = allDayQuietHoursConfirmText({ start_time: "08:00", end_time: "08:00" });
  assert.match(text, /08:00/);
  assert.match(text, /終日/);
  assert.match(text, /生成されなくなります/);
});

test("有効なお告げの当日の件数が設定回数に満たなければ、警告として表示する", () => {
  assert.deepEqual(todayStatus(item, []), {
    total: 0,
    pending: 0,
    tone: "warn",
    text: "今日 0 / 3 件（設定回数に足りません）",
  });
  const two = [schedule({ sent: true }), schedule(), schedule({ notification_id: 2 })];
  assert.deepEqual(todayStatus(item, two), {
    total: 2,
    pending: 1,
    tone: "warn",
    text: "今日 2 / 3 件（設定回数に足りません）",
  });
});

test("設定回数どおりに予定があれば、件数だけ表示する", () => {
  const three = [schedule({ sent: true }), schedule(), schedule({ manually_modified: true })];
  assert.deepEqual(todayStatus(item, three), { total: 3, pending: 2, tone: "ok", text: "今日 3 / 3 件" });
});

test("開始が終了より後のまま保存されていたお告げは、0件の理由を表示する", () => {
  const status = todayStatus({ ...item, start_time: "22:00", end_time: "06:00" }, []);
  assert.equal(status.tone, "warn");
  assert.match(status.text, /今日 0 \/ 3 件/);
  assert.match(status.text, /開始が終了より後/);
});

test("静かにする時間が終日で有効なら、足りない理由として表示する", () => {
  const allDay = { start_time: "08:00", end_time: "08:00", enabled: 1 };
  assert.equal(todayStatus(item, [], [allDay]).text, "今日 0 / 3 件（静かにする時間が終日のため生成されません）");
  assert.equal(todayStatus(item, [], [{ ...allDay, enabled: 0 }]).text, "今日 0 / 3 件（設定回数に足りません）");
  assert.equal(
    todayStatus(item, [], [{ start_time: "22:00", end_time: "08:00", enabled: true }]).text,
    "今日 0 / 3 件（設定回数に足りません）",
  );
});

test("無効なお告げは、当日の未送信分を送らないことを表示する", () => {
  assert.deepEqual(todayStatus({ ...item, enabled: 0 }, [schedule(), schedule({ sent: true })]), {
    total: 2,
    pending: 1,
    tone: "muted",
    text: "無効（今日の未送信 1 件は送りません）",
  });
  assert.equal(todayStatus({ ...item, enabled: false }, []).text, "無効（配信しません）");
});

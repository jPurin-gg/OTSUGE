import assert from "node:assert/strict";
import test from "node:test";
import {
  commitScheduleTime,
  isScheduleLocked,
  pastTimeConfirmMessage,
  planScheduleTimeChange,
  toTimeInputValue,
} from "./schedule-time";

// 端末のタイムゾーンに依存しないよう、時刻はすべてローカル時刻から作る。
function local(hour: number, minute: number, second = 0) {
  return new Date(2026, 10, 14, hour, minute, second);
}

function schedule(overrides: { sent?: boolean | number; discarded?: boolean | number } = {}) {
  return { scheduled_at: local(9, 42).toISOString(), sent: false, discarded: false, ...overrides };
}

// 確認と保存の呼び出しを記録する。
function recorder(confirmAnswer = true) {
  const saved: string[] = [];
  const confirmed: string[] = [];
  return {
    saved,
    confirmed,
    actions: {
      confirm: (message: string) => {
        confirmed.push(message);
        return confirmAnswer;
      },
      save: async (scheduledAt: string) => {
        saved.push(scheduledAt);
      },
    },
  };
}

test("時刻欄の値は端末のタイムゾーンの HH:MM になる", () => {
  assert.equal(toTimeInputValue(local(9, 42).toISOString()), "09:42");
  assert.equal(toTimeInputValue(local(0, 5).toISOString()), "00:05");
  assert.equal(toTimeInputValue(local(23, 59).toISOString()), "23:59");
  assert.equal(toTimeInputValue("not a date"), "");
});

test("送信済み・破棄済みの予定は変更不可と判定する", () => {
  assert.equal(isScheduleLocked({ sent: false, discarded: false }), false);
  assert.equal(isScheduleLocked({ sent: 0, discarded: 0 }), false);
  assert.equal(isScheduleLocked({ sent: true, discarded: false }), true);
  assert.equal(isScheduleLocked({ sent: 1, discarded: 1 }), true);
});

test("値が変わっていなければ変更なしになる", () => {
  const current = local(9, 42).toISOString();
  assert.deepEqual(planScheduleTimeChange(current, "09:42", local(8, 0)), { kind: "unchanged" });
  assert.deepEqual(planScheduleTimeChange(current, "09:42:00", local(8, 0)), { kind: "unchanged" });
});

test("空や時刻として読めない値は例外にならず不正と判定する", () => {
  const current = local(9, 42).toISOString();
  for (const value of ["", "  ", "9:42", "24:00", "12:60", "abc", "2026-11-15T09:42"]) {
    assert.deepEqual(planScheduleTimeChange(current, value, local(8, 0)), { kind: "invalid" }, value);
  }
  assert.deepEqual(planScheduleTimeChange("not a date", "09:42", local(8, 0)), { kind: "invalid" });
});

test("時刻を変えても日付は元の予定のまま変わらない", () => {
  const current = local(9, 42).toISOString();
  for (const [value, hour, minute] of [
    ["00:00", 0, 0],
    ["13:18", 13, 18],
    ["23:59", 23, 59],
  ] as const) {
    assert.deepEqual(planScheduleTimeChange(current, value, local(0, 0, 0)), {
      kind: "change",
      scheduledAt: local(hour, minute).toISOString(),
      pastEffect: value === "00:00" ? "send" : null,
    });
  }
});

test("未来の時刻への変更は確認なしで保存できる", () => {
  const change = planScheduleTimeChange(local(9, 42).toISOString(), "12:31", local(12, 30, 59));
  assert.deepEqual(change, { kind: "change", scheduledAt: local(12, 31).toISOString(), pastEffect: null });
});

test("現在より前で30分以内の時刻は次の配信処理で送信される", () => {
  const current = local(9, 42).toISOString();
  const now = local(12, 30, 20);
  // 次の配信処理は 12:31。12:01 より後の予定は送信される。
  for (const value of ["12:30", "12:15", "12:02"]) {
    const change = planScheduleTimeChange(current, value, now);
    assert.equal(change.kind === "change" && change.pastEffect, "send", value);
  }
});

test("次の配信処理の時点で30分以上過ぎている時刻は破棄される", () => {
  const current = local(9, 42).toISOString();
  const now = local(12, 30, 20);
  for (const value of ["12:01", "12:00", "00:00"]) {
    const change = planScheduleTimeChange(current, value, now);
    assert.equal(change.kind === "change" && change.pastEffect, "discard", value);
  }
});

test("確認文は送信と破棄で内容が変わる", () => {
  assert.match(pastTimeConfirmMessage("12:15", "send"), /^12:15 は現在より前の時刻です。.*送信されます/);
  assert.match(pastTimeConfirmMessage("12:00:00", "discard"), /^12:00 は現在より30分以上前の時刻です。.*破棄されます/);
});

test("何も変えずにフォーカスを外しても保存も確認もしない", async () => {
  const { saved, confirmed, actions } = recorder();
  assert.equal(await commitScheduleTime(schedule(), "09:42", { ...actions, now: local(12, 0) }), "unchanged");
  assert.deepEqual(saved, []);
  assert.deepEqual(confirmed, []);
});

test("欄を空にしても例外にならず、保存しない", async () => {
  const { saved, confirmed, actions } = recorder();
  assert.equal(await commitScheduleTime(schedule(), "", { ...actions, now: local(8, 0) }), "invalid");
  assert.deepEqual(saved, []);
  assert.deepEqual(confirmed, []);
});

test("未来の時刻に変えると確認なしで保存する", async () => {
  const { saved, confirmed, actions } = recorder();
  assert.equal(await commitScheduleTime(schedule(), "13:18", { ...actions, now: local(8, 0) }), "saved");
  assert.deepEqual(saved, [local(13, 18).toISOString()]);
  assert.deepEqual(confirmed, []);
});

test("現在より前の時刻に変えると確認を出し、同意したら保存する", async () => {
  const { saved, confirmed, actions } = recorder(true);
  assert.equal(await commitScheduleTime(schedule(), "11:50", { ...actions, now: local(12, 0) }), "saved");
  assert.deepEqual(saved, [local(11, 50).toISOString()]);
  assert.equal(confirmed.length, 1);
  assert.match(confirmed[0], /送信されます/);
});

test("現在より前の時刻の確認を断ると保存しない", async () => {
  const { saved, confirmed, actions } = recorder(false);
  assert.equal(await commitScheduleTime(schedule(), "08:00", { ...actions, now: local(12, 0) }), "cancelled");
  assert.deepEqual(saved, []);
  assert.equal(confirmed.length, 1);
  assert.match(confirmed[0], /破棄されます/);
});

test("送信済み・破棄済みの予定は値を変えても保存しない", async () => {
  for (const target of [schedule({ sent: true }), schedule({ sent: 1, discarded: 1 })]) {
    const { saved, confirmed, actions } = recorder();
    assert.equal(await commitScheduleTime(target, "13:18", { ...actions, now: local(8, 0) }), "locked");
    assert.deepEqual(saved, []);
    assert.deepEqual(confirmed, []);
  }
});

test("保存の失敗は呼び出し元に伝える", async () => {
  await assert.rejects(
    commitScheduleTime(schedule(), "13:18", {
      confirm: () => true,
      save: async () => {
        throw new Error("通信に失敗しました。");
      },
      now: local(8, 0),
    }),
    /通信に失敗しました。/,
  );
});

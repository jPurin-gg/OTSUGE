import assert from "node:assert/strict";
import test from "node:test";
import {
  confirmAndSend,
  ConfirmSchedule,
  countRegeneration,
  isResend,
  regenerateConfirmText,
  scheduleState,
  sendConfirmText,
} from "./admin-confirm";
import { formatTime } from "./api";

const SCHEDULED_AT = "2026-11-14T09:30:00.000Z";
// 表示時刻は端末のタイムゾーンで決まるので、画面と同じ関数で期待値をつくる。
const TIME = formatTime(SCHEDULED_AT);

function schedule(overrides: Partial<ConfirmSchedule & { notification_id: number }> = {}) {
  return {
    notification_id: 1,
    scheduled_at: SCHEDULED_AT,
    sent: false,
    discarded: false,
    manually_modified: false,
    message: "水を飲め",
    ...overrides,
  };
}

const unsent = schedule();
const sent = schedule({ sent: true });
const discarded = schedule({ sent: true, discarded: true });

// confirm と send の呼び出しを記録する。
function recorder(answer: boolean) {
  const confirms: string[] = [];
  const sends: { resend: boolean }[] = [];
  return {
    confirms,
    sends,
    actions: {
      confirm: (text: string) => {
        confirms.push(text);
        return answer;
      },
      send: async (options: { resend: boolean }) => {
        sends.push(options);
        return { delivered: 3 };
      },
    },
  };
}

test("scheduleState: SQLite の 0/1 でも真偽値でも同じ状態になる", () => {
  assert.equal(scheduleState({ sent: 0, discarded: 0 }), "unsent");
  assert.equal(scheduleState({ sent: 1, discarded: 0 }), "sent");
  assert.equal(scheduleState({ sent: 1, discarded: 1 }), "discarded");
  assert.equal(isResend(unsent), false);
  assert.equal(isResend(sent), true);
  assert.equal(isResend(discarded), true);
});

test("sendConfirmText: 本文・予定時刻・送信先の件数が入る", () => {
  const text = sendConfirmText(unsent, 3);
  assert.match(text, /今すぐ送ります/);
  assert.ok(text.includes("「水を飲め」"));
  assert.ok(text.includes(TIME));
  assert.ok(text.includes("未送信"));
  assert.ok(text.includes("購読 3件すべて"));
  assert.match(text, /取り消せません/);
  assert.doesNotMatch(text, /再送/);
});

test("sendConfirmText: 送信済み・破棄済みは再送であることが分かる", () => {
  const sentText = sendConfirmText(sent, 3);
  assert.match(sentText, /【再送】/);
  assert.match(sentText, /送信済み/);
  assert.match(sentText, /もう一度届きます/);
  assert.match(sentText, /再送しますか？/);
  assert.ok(sentText.includes("「水を飲め」"));
  assert.ok(sentText.includes("購読 3件すべて"));

  const discardedText = sendConfirmText(discarded, 3);
  assert.match(discardedText, /【再送】/);
  assert.match(discardedText, /破棄済み/);
  assert.match(discardedText, /再送しますか？/);
});

test("sendConfirmText: 購読が0件なら、誰にも届かないが送信済みになることを伝える", () => {
  const text = sendConfirmText(unsent, 0);
  assert.match(text, /購読は0件/);
  assert.match(text, /送信済みになります/);
});

test("confirmAndSend: 確認に同意しなければ送信しない", async () => {
  for (const target of [unsent, sent, discarded]) {
    const { actions, confirms, sends } = recorder(false);
    assert.deepEqual(await confirmAndSend(target, 3, actions), { sent: false });
    assert.equal(confirms.length, 1);
    assert.equal(sends.length, 0);
  }
});

test("confirmAndSend: 未送信は確認のあと resend なしで送る", async () => {
  const { actions, confirms, sends } = recorder(true);
  const outcome = await confirmAndSend(unsent, 3, actions);
  assert.deepEqual(outcome, { sent: true, resend: false, result: { delivered: 3 } });
  assert.deepEqual(confirms, [sendConfirmText(unsent, 3)]);
  assert.deepEqual(sends, [{ resend: false }]);
});

test("confirmAndSend: 送信済み・破棄済みは再送の確認のあと resend: true で送る", async () => {
  for (const target of [sent, discarded]) {
    const { actions, confirms, sends } = recorder(true);
    const outcome = await confirmAndSend(target, 3, actions);
    assert.deepEqual(outcome, { sent: true, resend: true, result: { delivered: 3 } });
    assert.match(confirms[0], /【再送】/);
    assert.deepEqual(sends, [{ resend: true }]);
  }
});

test("confirmAndSend: 送信の失敗はそのまま投げる", async () => {
  const failure = new Error("この通知予定はすでに送信済みです。");
  await assert.rejects(
    confirmAndSend(unsent, 3, {
      confirm: () => true,
      send: async () => {
        throw failure;
      },
    }),
    failure,
  );
});

test("countRegeneration: backend と同じ条件（未送信かつ手動編集でない）で削除件数を数える", () => {
  const schedules = [
    unsent,
    schedule({ sent: 0, manually_modified: 0 }),
    schedule({ manually_modified: true }),
    sent,
    schedule({ sent: true, manually_modified: true }),
    discarded,
  ];
  assert.deepEqual(countRegeneration(schedules), { deleted: 2, keptDone: 3, keptManual: 1 });
  assert.deepEqual(countRegeneration([]), { deleted: 0, keptDone: 0, keptManual: 0 });
});

test("regenerateConfirmText: 削除される予定の件数と、残る予定が入る", () => {
  const text = regenerateConfirmText([unsent, unsent, schedule({ manually_modified: true }), sent, discarded]);
  assert.match(text, /引き直します/);
  assert.ok(text.includes("未送信の予定 2件を削除"));
  assert.ok(text.includes("送信済み・破棄済みの予定 2件"));
  assert.ok(text.includes("手動編集した未送信の予定 1件"));
  assert.match(text, /は残ります/);
  assert.match(text, /元に戻せません/);
});

test("regenerateConfirmText: 削除される予定がないときも、そのことを伝えて確認する", () => {
  const empty = regenerateConfirmText([]);
  assert.match(empty, /削除される予定はありません/);
  assert.match(empty, /実行しますか？/);
  assert.doesNotMatch(empty, /は残ります/);

  const onlySent = regenerateConfirmText([sent]);
  assert.match(onlySent, /削除される予定はありません/);
  assert.ok(onlySent.includes("送信済み・破棄済みの予定 1件は残ります"));
});

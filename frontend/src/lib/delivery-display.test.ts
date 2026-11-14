import assert from "node:assert/strict";
import test from "node:test";
import {
  deliveryCountsText,
  deliveryLogDetail,
  deliveryLogDisplay,
  deliveryOutcome,
  formatDateTime,
  homeStatusDisplay,
  scheduleStatusDisplay,
  sendResultMessage,
  todaySentNote,
} from "./delivery-display";

const counts = (delivered: number, failed: number, removed = 0) => ({
  delivered_count: delivered,
  failed_count: failed,
  removed_subscription_count: removed,
});

test("送信時刻に月日を付け、日付をまたぐログを区別できる", () => {
  // 2026-11-13 09:42 JST と 2026-11-14 09:42 JST
  const yesterday = formatDateTime("2026-11-13T00:42:00.000Z", "Asia/Tokyo");
  const today = formatDateTime("2026-11-14T00:42:00.000Z", "Asia/Tokyo");
  assert.equal(yesterday, "11/13 09:42");
  assert.equal(today, "11/14 09:42");
  assert.notEqual(yesterday, today);
  // 0時台は「24:05」ではなく「00:05」、1桁の月日はそのまま。
  assert.equal(formatDateTime("2026-01-04T15:05:00.000Z", "Asia/Tokyo"), "1/5 00:05");
});

test("配信結果を「全員に成功 / 一部失敗 / 全件失敗 / 対象なし」に分ける", () => {
  assert.equal(deliveryOutcome(counts(3, 0)), "success");
  assert.equal(deliveryOutcome(counts(2, 1)), "partial");
  assert.equal(deliveryOutcome(counts(0, 3)), "failed");
  assert.equal(deliveryOutcome(counts(0, 0)), "no-target");
});

test("全件失敗・対象なしのログは、緑の「送信済み」にならない", () => {
  assert.deepEqual(deliveryLogDisplay({ status: "sent", ...counts(3, 0) }), { label: "全員に成功", tone: "success" });
  assert.deepEqual(deliveryLogDisplay({ status: "sent", ...counts(2, 1) }), { label: "一部失敗", tone: "warning" });
  assert.deepEqual(deliveryLogDisplay({ status: "sent", ...counts(0, 3) }), { label: "全件失敗", tone: "danger" });
  assert.deepEqual(deliveryLogDisplay({ status: "sent", ...counts(0, 0) }), { label: "対象なし", tone: "muted" });
  assert.deepEqual(deliveryLogDisplay({ status: "discarded", ...counts(0, 0) }), { label: "破棄", tone: "danger" });
});

test("無効な購読の削除は、失敗の内数として書く（「購読解除」とは書かない）", () => {
  assert.equal(deliveryCountsText(counts(1, 2, 2)), "成功 1件 / 失敗 2件（うち無効な購読を削除 2件）");
  assert.equal(deliveryCountsText(counts(3, 1, 0)), "成功 3件 / 失敗 1件");
  assert.equal(deliveryCountsText(counts(3, 0, 0)), "成功 3件 / 失敗 0件");
  for (const text of [deliveryCountsText(counts(1, 2, 2)), sendResultMessage({ delivered: 1, failed: 2, removed: 2 })]) {
    assert.ok(!text.includes("購読解除"));
  }
});

test("ログの内訳は、破棄と対象なしでは件数の代わりに理由を書く", () => {
  assert.equal(deliveryLogDetail({ status: "sent", ...counts(0, 3, 1) }), "成功 0件 / 失敗 3件（うち無効な購読を削除 1件）");
  assert.equal(deliveryLogDetail({ status: "sent", ...counts(0, 0) }), "購読者がいないため、どこにも送っていません。");
  assert.equal(
    deliveryLogDetail({ status: "discarded", ...counts(0, 0) }),
    "予定時刻から30分以上過ぎたため、送信していません。",
  );
});

test("即時送信の結果メッセージは、結果に応じて書き出しを変える", () => {
  assert.equal(sendResultMessage({ delivered: 2, failed: 0, removed: 0 }), "今すぐ送りました。成功 2件 / 失敗 0件");
  assert.equal(
    sendResultMessage({ delivered: 1, failed: 1, removed: 1 }),
    "今すぐ送りましたが、一部に届きませんでした。成功 1件 / 失敗 1件（うち無効な購読を削除 1件）",
  );
  assert.equal(sendResultMessage({ delivered: 0, failed: 3, removed: 0 }), "送信はすべて失敗しました。成功 0件 / 失敗 3件");
  assert.equal(sendResultMessage({ delivered: 0, failed: 0, removed: 0 }), "購読者がいないため、どこにも送れませんでした。");
});

test("配信予定の行は、送信済みでも結果を添える", () => {
  const sent = { sent: 1, discarded: 0 };
  assert.deepEqual(scheduleStatusDisplay({ sent: 0, discarded: 0 }), { label: "未送信", tone: "muted" });
  assert.deepEqual(scheduleStatusDisplay({ sent: 1, discarded: 1 }), { label: "破棄", tone: "danger" });
  assert.deepEqual(scheduleStatusDisplay({ ...sent, last_delivery: counts(2, 0) }), {
    label: "送信済み（全員に成功）",
    tone: "success",
  });
  assert.deepEqual(scheduleStatusDisplay({ ...sent, last_delivery: counts(1, 1) }), {
    label: "送信済み（一部失敗）",
    tone: "warning",
  });
  assert.deepEqual(scheduleStatusDisplay({ ...sent, last_delivery: counts(0, 2) }), {
    label: "送信済み（全件失敗）",
    tone: "danger",
  });
  assert.deepEqual(scheduleStatusDisplay({ ...sent, last_delivery: counts(0, 0) }), {
    label: "送信済み（対象なし）",
    tone: "muted",
  });
  // 送信結果が付いていない応答（古い backend など）では、これまでどおりの表示にする。
  assert.deepEqual(scheduleStatusDisplay(sent), { label: "送信済み", tone: "muted" });
  assert.deepEqual(scheduleStatusDisplay({ ...sent, last_delivery: null }), { label: "送信済み", tone: "muted" });
});

test("ホームは、誰にも届いていない予定を「送信済」と表示しない", () => {
  const sent = { sent: true, discarded: false };
  assert.deepEqual(homeStatusDisplay({ sent: false, discarded: false }), { label: "待機中", tone: "success" });
  assert.deepEqual(homeStatusDisplay({ sent: true, discarded: true }), { label: "破棄", tone: "danger" });
  assert.deepEqual(homeStatusDisplay({ ...sent, delivery_outcome: "failed" }), { label: "送信失敗", tone: "warning" });
  assert.deepEqual(homeStatusDisplay({ ...sent, delivery_outcome: "no_target" }), { label: "対象なし", tone: "muted" });
  for (const delivery_outcome of ["delivered", "partial", null, undefined]) {
    assert.deepEqual(homeStatusDisplay({ ...sent, delivery_outcome }), { label: "送信済", tone: "muted" });
  }
});

test("統計カード「今日の送信」の補足は、届かなかった送信があれば色を変える", () => {
  assert.deepEqual(todaySentNote({ todaySentCount: 0, todayUndeliveredCount: 0 }), {
    label: "まだ送信していません",
    tone: "muted",
  });
  assert.deepEqual(todaySentNote({ todaySentCount: 60, todayUndeliveredCount: 0 }), {
    label: "すべて全員に成功",
    tone: "success",
  });
  assert.deepEqual(todaySentNote({ todaySentCount: 60, todayUndeliveredCount: 2 }), {
    label: "うち失敗・対象なし 2回",
    tone: "danger",
  });
});

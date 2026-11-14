// 送信結果の表示用の文言と区分。配信の状態そのものは変えず、記録済みの件数の見せ方だけを決める。

export type DeliveryCounts = {
  delivered_count: number;
  failed_count: number;
  removed_subscription_count: number;
};

/** success: 全員に成功 / partial: 一部失敗 / failed: 全件失敗 / no-target: 送信対象（購読）なし */
export type DeliveryOutcome = "success" | "partial" | "failed" | "no-target";

export type DeliveryTone = "success" | "warning" | "danger" | "muted";

export type DeliveryDisplay = { label: string; tone: DeliveryTone };

/** 「11/13 09:42」の形式。日付をまたぐ一覧でも区別できるよう月日を付ける。 */
export function formatDateTime(value: string, timeZone?: string) {
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone,
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(new Date(value));
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value ?? "";
  return `${part("month")}/${part("day")} ${part("hour").padStart(2, "0")}:${part("minute").padStart(2, "0")}`;
}

export function deliveryOutcome(counts: Pick<DeliveryCounts, "delivered_count" | "failed_count">): DeliveryOutcome {
  const delivered = Number(counts.delivered_count);
  const failed = Number(counts.failed_count);
  if (delivered > 0) return failed > 0 ? "partial" : "success";
  return failed > 0 ? "failed" : "no-target";
}

const outcomeDisplay: Record<DeliveryOutcome, DeliveryDisplay> = {
  success: { label: "全員に成功", tone: "success" },
  partial: { label: "一部失敗", tone: "warning" },
  failed: { label: "全件失敗", tone: "danger" },
  "no-target": { label: "対象なし", tone: "muted" },
};

/** 送信ログ1件の状態表示。破棄はこれまでどおり「破棄」。 */
export function deliveryLogDisplay(log: { status: string } & DeliveryCounts): DeliveryDisplay {
  if (log.status === "discarded") return { label: "破棄", tone: "danger" };
  return outcomeDisplay[deliveryOutcome(log)];
}

/**
 * 件数の内訳。無効な購読の削除は失敗の内数なので、失敗の中に入れて書く。
 * 例: 「成功 1件 / 失敗 2件（うち無効な購読を削除 2件）」
 */
export function deliveryCountsText(counts: DeliveryCounts) {
  const removed = Number(counts.removed_subscription_count);
  const removedText = removed > 0 ? `（うち無効な購読を削除 ${removed}件）` : "";
  return `成功 ${counts.delivered_count}件 / 失敗 ${counts.failed_count}件${removedText}`;
}

/** 送信ログ1件の内訳の行。 */
export function deliveryLogDetail(log: { status: string } & DeliveryCounts) {
  if (log.status === "discarded") return "予定時刻から30分以上過ぎたため、送信していません。";
  if (deliveryOutcome(log) === "no-target") return "購読者がいないため、どこにも送っていません。";
  return deliveryCountsText(log);
}

/** 「今すぐ送る」の結果メッセージ。 */
export function sendResultMessage(result: { delivered: number; failed: number; removed: number }) {
  const counts = {
    delivered_count: result.delivered,
    failed_count: result.failed,
    removed_subscription_count: result.removed,
  };
  const outcome = deliveryOutcome(counts);
  if (outcome === "no-target") return "購読者がいないため、どこにも送れませんでした。";
  const lead = {
    success: "今すぐ送りました。",
    partial: "今すぐ送りましたが、一部に届きませんでした。",
    failed: "送信はすべて失敗しました。",
  }[outcome];
  return `${lead}${deliveryCountsText(counts)}`;
}

/** 管理画面の配信予定の行の状態。last_delivery は最新の送信結果（なければ null）。 */
export function scheduleStatusDisplay(schedule: {
  sent: boolean | number;
  discarded: boolean | number;
  last_delivery?: DeliveryCounts | null;
}): DeliveryDisplay {
  if (!Boolean(schedule.sent)) return { label: "未送信", tone: "muted" };
  if (Boolean(schedule.discarded)) return { label: "破棄", tone: "danger" };
  if (!schedule.last_delivery) return { label: "送信済み", tone: "muted" };
  const display = outcomeDisplay[deliveryOutcome(schedule.last_delivery)];
  return { label: `送信済み（${display.label}）`, tone: display.tone };
}

/**
 * 利用者向けホームの予定の状態。利用者には自分に届いたかどうかまでは分からないので、
 * 誰にも届いていないとき（全件失敗・対象なし）だけ「送信済」と分けて見せる。
 */
export function homeStatusDisplay(schedule: {
  sent: boolean | number;
  discarded: boolean | number;
  delivery_outcome?: string | null;
}): DeliveryDisplay {
  if (!Boolean(schedule.sent)) return { label: "待機中", tone: "success" };
  if (Boolean(schedule.discarded)) return { label: "破棄", tone: "danger" };
  if (schedule.delivery_outcome === "failed") return { label: "送信失敗", tone: "warning" };
  if (schedule.delivery_outcome === "no_target") return { label: "対象なし", tone: "muted" };
  return { label: "送信済", tone: "muted" };
}

/** 統計カード「今日の送信」の補足。 */
export function todaySentNote(stats: { todaySentCount: number; todayUndeliveredCount: number }): DeliveryDisplay {
  if (stats.todaySentCount === 0) return { label: "まだ送信していません", tone: "muted" };
  if (stats.todayUndeliveredCount === 0) return { label: "すべて全員に成功", tone: "success" };
  return { label: `うち失敗・対象なし ${stats.todayUndeliveredCount}回`, tone: "danger" };
}

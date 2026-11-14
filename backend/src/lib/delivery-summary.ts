import type { Knex } from "knex";
import { dayBounds, localDateKey } from "./time";

// 配信結果の「表示用」の要約。配信の状態（schedules.sent / delivery_logs.status）は変えず、
// 記録済みの件数から読み取れることだけを返す。

export type DeliveryCounts = {
  delivered_count: number;
  failed_count: number;
  removed_subscription_count: number;
};

/** delivered: 全員に成功 / partial: 一部失敗 / failed: 全件失敗 / no_target: 送信対象（購読）なし */
export type DeliveryOutcome = "delivered" | "partial" | "failed" | "no_target";

export function deliveryOutcome(counts: Pick<DeliveryCounts, "delivered_count" | "failed_count">): DeliveryOutcome {
  const delivered = Number(counts.delivered_count);
  const failed = Number(counts.failed_count);
  if (delivered > 0) return failed > 0 ? "partial" : "delivered";
  return failed > 0 ? "failed" : "no_target";
}

/** 予定ごとの、いちばん新しい送信（status = "sent"）の件数。送信ログがない予定はキーを持たない。 */
export async function latestDeliveryBySchedule(database: Knex, scheduleIds: number[]) {
  const latest = new Map<number, DeliveryCounts>();
  if (scheduleIds.length === 0) return latest;
  const rows = (await database("delivery_logs")
    .select("schedule_id", "delivered_count", "failed_count", "removed_subscription_count")
    .whereIn("schedule_id", scheduleIds)
    .andWhere({ status: "sent" })
    .orderBy([
      { column: "sent_at", order: "desc" },
      { column: "id", order: "desc" },
    ])) as (DeliveryCounts & { schedule_id: number })[];
  for (const row of rows) {
    if (latest.has(row.schedule_id)) continue;
    latest.set(row.schedule_id, {
      delivered_count: Number(row.delivered_count),
      failed_count: Number(row.failed_count),
      removed_subscription_count: Number(row.removed_subscription_count),
    });
  }
  return latest;
}

/**
 * 今日（APP_TIMEZONE の日付）に送信した回数と、そのうち全員には届かなかった回数。
 * 送信ログ一覧（最新50件）とは別に数えるので、ログが増えても頭打ちにならない。
 */
export async function todayDeliveryStats(database: Knex, now = new Date()) {
  const { start, end } = dayBounds(localDateKey(now));
  const rows = (await database("delivery_logs")
    .select("delivered_count", "failed_count")
    .where({ status: "sent" })
    .andWhere("sent_at", ">=", start.toISOString())
    .andWhere("sent_at", "<", end.toISOString())) as Pick<DeliveryCounts, "delivered_count" | "failed_count">[];
  return {
    todaySentCount: rows.length,
    todayUndeliveredCount: rows.filter((row) => deliveryOutcome(row) !== "delivered").length,
  };
}

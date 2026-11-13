import type { Knex } from "knex";
import { dayBounds, localDateKey } from "./time";

export type ScheduleTimeUpdateResult =
  /** 時刻を変更し、手動編集にした。 */
  | "updated"
  /** 現在と同じ時刻だったので何も書き換えていない（手動編集にもしない）。 */
  | "unchanged"
  | "not_found"
  /** 送信済み・破棄済みの予定は変更しない。 */
  | "locked"
  /** 予定と同じ日（APP_TIMEZONE の暦日）から外れる時刻は受け付けない。 */
  | "other_day";

/**
 * 管理者による配信時刻の変更。仕様書 5.5 の「通知時刻変更」で、最低通知間隔・通知禁止時間帯は見ない。
 * 値が実際に変わったときだけ manually_modified を立てる。再生成は手動編集の予定を残すので、
 * 変えていない予定まで手動編集にすると、再生成のたびにその日の通知が増える。
 */
export async function updateScheduleTime(
  database: Knex,
  id: number,
  scheduledAt: string,
): Promise<ScheduleTimeUpdateResult> {
  if (!Number.isInteger(id)) return "not_found";
  const schedule = (await database("schedules").where({ id }).first()) as
    | { scheduled_at: string | Date; sent: boolean | number }
    | undefined;
  if (!schedule) return "not_found";
  if (Boolean(schedule.sent)) return "locked";

  // SQLite は保存した文字列、PostgreSQL は Date で返るので、時刻として比べる。
  const current = new Date(schedule.scheduled_at);
  const next = new Date(scheduledAt);
  if (current.getTime() === next.getTime()) return "unchanged";

  const { start, end } = dayBounds(localDateKey(current));
  if (next < start || next >= end) return "other_day";

  // 読み取り後に送信・破棄された場合は書き換えない。
  const updated = await database("schedules").where({ id, sent: false }).update({
    scheduled_at: next.toISOString(),
    manually_modified: true,
    updated_at: new Date().toISOString(),
  });
  return updated > 0 ? "updated" : "locked";
}

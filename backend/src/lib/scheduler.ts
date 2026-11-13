import type { Knex } from "knex";
import type { NotificationRecord, QuietHoursRecord } from "./types";
import { dayBounds, localDateKey, localMinuteOfDay, minutesFromTime, timeFromMinutes, zonedDateTimeToUtc } from "./time";

export function isQuietMinute(minute: number, quietHours: Pick<QuietHoursRecord, "start_time" | "end_time" | "enabled">[]) {
  return quietHours.some((quiet) => {
    if (!quiet.enabled) return false;
    const start = minutesFromTime(quiet.start_time);
    const end = minutesFromTime(quiet.end_time);
    if (start === end) return true;
    return start < end ? minute >= start && minute < end : minute >= start || minute < end;
  });
}

/** お告げの終了時刻を分に直す。終了 `00:00` は「23:59 まで」として扱う。 */
export function notificationEndMinute(endTime: string) {
  return endTime === "00:00" ? 23 * 60 + 59 : minutesFromTime(endTime);
}

export function chooseMinutes(
  notification: Pick<NotificationRecord, "start_time" | "end_time" | "count_per_day" | "min_interval_minutes">,
  quietHours: Pick<QuietHoursRecord, "start_time" | "end_time" | "enabled">[],
  random = Math.random,
  earliestMinute = 0,
) {
  const start = Math.max(minutesFromTime(notification.start_time), earliestMinute);
  const end = notificationEndMinute(notification.end_time);
  if (end < start) return [];

  const candidates = Array.from({ length: end - start + 1 }, (_, index) => start + index)
    .filter((minute) => !isQuietMinute(minute, quietHours))
    .sort(() => random() - 0.5);

  const selected: number[] = [];
  for (const minute of candidates) {
    if (selected.every((existing) => Math.abs(existing - minute) >= notification.min_interval_minutes)) {
      selected.push(minute);
      if (selected.length === notification.count_per_day) break;
    }
  }
  return selected.sort((a, b) => a - b);
}

export async function generateDailySchedules(database: Knex, dateKey = localDateKey()) {
  const notifications = (await database("notifications").where({ enabled: true })) as NotificationRecord[];
  const quietHours = (await database("quiet_hours").where({ enabled: true })) as QuietHoursRecord[];
  const { start, end } = dayBounds(dateKey);
  const now = new Date();
  const earliestMinute = dateKey === localDateKey(now) ? Math.min(localMinuteOfDay(now) + 1, 24 * 60) : 0;

  await database("schedules")
    .where("scheduled_at", ">=", start.toISOString())
    .andWhere("scheduled_at", "<", end.toISOString())
    .andWhere({ sent: false, manually_modified: false })
    .delete();

  let generated = 0;
  const warnings: string[] = [];
  for (const notification of notifications) {
    const selected = chooseMinutes(notification, quietHours, Math.random, earliestMinute);
    if (selected.length < notification.count_per_day) {
      warnings.push(`「${notification.message}」は条件内で${selected.length}件のみ生成しました。`);
    }
    if (!selected.length) continue;
    const createdAt = now.toISOString();
    await database("schedules").insert(
      selected.map((minute) => ({
        notification_id: notification.id,
        scheduled_at: zonedDateTimeToUtc(dateKey, timeFromMinutes(minute)).toISOString(),
        sent: false,
        discarded: false,
        manually_modified: false,
        created_at: createdAt,
        updated_at: createdAt,
      })),
    );
    generated += selected.length;
  }
  return { generated, warnings, date: dateKey };
}

/**
 * 1つのお告げだけ、指定日の予定を引き直す（設定を変えた当日に反映するため）。
 * そのお告げの未送信の予定（手動編集を除く）を削除し、現在の設定で作り直す。
 * 送信済み・破棄済み・手動編集した予定と、ほかのお告げの予定には触れない。
 * 無効なお告げは生成の対象外なので、削除だけ行う。お告げがなければ null を返す。
 */
export async function regenerateNotificationSchedules(database: Knex, notificationId: number, dateKey = localDateKey()) {
  return database.transaction(async (transaction) => {
    const notification = (await transaction("notifications").where({ id: notificationId }).first()) as
      | NotificationRecord
      | undefined;
    if (!notification) return null;

    const quietHours = (await transaction("quiet_hours").where({ enabled: true })) as QuietHoursRecord[];
    const { start, end } = dayBounds(dateKey);
    const now = new Date();
    const earliestMinute = dateKey === localDateKey(now) ? Math.min(localMinuteOfDay(now) + 1, 24 * 60) : 0;

    const removed = await transaction("schedules")
      .where({ notification_id: notification.id, sent: false, manually_modified: false })
      .andWhere("scheduled_at", ">=", start.toISOString())
      .andWhere("scheduled_at", "<", end.toISOString())
      .delete();

    const warnings: string[] = [];
    if (!Boolean(notification.enabled)) {
      warnings.push(`「${notification.message}」は無効のため、新しい予定は生成しませんでした。`);
      return { generated: 0, removed, warnings, date: dateKey };
    }

    const selected = chooseMinutes(notification, quietHours, Math.random, earliestMinute);
    if (selected.length < notification.count_per_day) {
      warnings.push(`「${notification.message}」は条件内で${selected.length}件のみ生成しました。`);
    }
    if (selected.length) {
      const createdAt = now.toISOString();
      await transaction("schedules").insert(
        selected.map((minute) => ({
          notification_id: notification.id,
          scheduled_at: zonedDateTimeToUtc(dateKey, timeFromMinutes(minute)).toISOString(),
          sent: false,
          discarded: false,
          manually_modified: false,
          created_at: createdAt,
          updated_at: createdAt,
        })),
      );
    }
    return { generated: selected.length, removed, warnings, date: dateKey };
  });
}

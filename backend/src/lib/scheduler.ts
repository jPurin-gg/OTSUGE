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

export function chooseMinutes(
  notification: Pick<NotificationRecord, "start_time" | "end_time" | "count_per_day" | "min_interval_minutes">,
  quietHours: Pick<QuietHoursRecord, "start_time" | "end_time" | "enabled">[],
  random = Math.random,
  earliestMinute = 0,
) {
  const start = Math.max(minutesFromTime(notification.start_time), earliestMinute);
  const end = notification.end_time === "00:00" ? 23 * 60 + 59 : minutesFromTime(notification.end_time);
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

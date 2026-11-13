import { z } from "zod";
import { notificationEndMinute } from "./scheduler";
import { minutesFromTime } from "./time";

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

/** 開始が終了より後のお告げは、生成が1件もできないので保存させない。 */
export const NOTIFICATION_TIME_ORDER_ERROR =
  "開始は終了より前の時刻にしてください（日をまたぐ時間帯は設定できません。終了を 00:00 にすると「23:59 まで」になります）。";

export const notificationInput = z
  .object({
    message: z.string().trim().min(1).max(200),
    start_time: time,
    end_time: time,
    count_per_day: z.coerce.number().int().min(1).max(100),
    min_interval_minutes: z.coerce.number().int().min(0).max(1440),
    enabled: z.boolean(),
  })
  .refine((input) => minutesFromTime(input.start_time) <= notificationEndMinute(input.end_time), {
    path: ["end_time"],
    message: NOTIFICATION_TIME_ORDER_ERROR,
  });

export const quietHoursInput = z.object({
  start_time: time,
  end_time: time,
  enabled: z.boolean(),
});

export const scheduleInput = z.object({
  scheduled_at: z.string().datetime(),
});

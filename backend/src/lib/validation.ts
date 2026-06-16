import { z } from "zod";

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export const notificationInput = z.object({
  message: z.string().trim().min(1).max(200),
  start_time: time,
  end_time: time,
  count_per_day: z.coerce.number().int().min(1).max(100),
  min_interval_minutes: z.coerce.number().int().min(0).max(1440),
  enabled: z.boolean(),
});

export const quietHoursInput = z.object({
  start_time: time,
  end_time: time,
  enabled: z.boolean(),
});

export const scheduleInput = z.object({
  scheduled_at: z.string().datetime(),
});

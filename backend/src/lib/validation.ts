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

export const sendInput = z.object({
  resend: z.boolean().default(false),
});

/**
 * 即時送信のリクエスト本文を読む。本文がなければ再送の指定なし（resend: false）として扱う。
 * JSON として読めない本文は、そのまま検証に渡して入力エラーにする。
 */
export function parseSendInput(body: string) {
  if (!body.trim()) return sendInput.parse({});
  let data: unknown = body;
  try {
    data = JSON.parse(body);
  } catch {
    // 文字列のまま検証し、入力エラーにする。
  }
  return sendInput.parse(data);
}

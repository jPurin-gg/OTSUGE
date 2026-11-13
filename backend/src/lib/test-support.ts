// テスト専用の共通処理。アプリ本体からは読み込まない。
import { createHash } from "node:crypto";
import type { Knex } from "knex";
import { NextRequest } from "next/server";

process.env.SQLITE_PATH = ":memory:";
process.env.APP_TIMEZONE = "Asia/Tokyo";
process.env.ADMIN_PASSWORD = "test-password";
process.env.AUTH_SECRET = "test-secret";
process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY = "test-public-key";
process.env.VAPID_PRIVATE_KEY = "test-private-key";
process.env.VAPID_SUBJECT = "mailto:test@example.invalid";

/** テストで「今」として固定する時刻（Asia/Tokyo の 2026-11-14 12:00）。 */
export const NOW = new Date("2026-11-14T03:00:00.000Z");
export const TODAY = "2026-11-14";

const ADMIN_COOKIE = `otsuge_admin=${createHash("sha256").update("test-password:test-secret").digest("hex")}`;

/** db.ts は読み込み時に接続先を決めるので、上の環境変数を設定してから読み込む。 */
export async function openTestDatabase(): Promise<Knex> {
  const { readyDb } = await import("./db");
  return readyDb();
}

export function adminRequest(path: string, init: { method: string; body?: unknown }) {
  return new NextRequest(`http://localhost${path}`, {
    method: init.method,
    headers: { cookie: ADMIN_COOKIE, "content-type": "application/json" },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

export function routeContext(id: number | string) {
  return { params: Promise.resolve({ id: String(id) }) };
}

type NotificationValues = {
  message: string;
  start_time: string;
  end_time: string;
  count_per_day: number;
  min_interval_minutes: number;
  enabled: boolean;
};

export async function insertNotification(database: Knex, values: Partial<NotificationValues> = {}) {
  const [id] = await database("notifications").insert({
    message: "水を飲め",
    start_time: "09:00",
    end_time: "22:00",
    count_per_day: 1,
    min_interval_minutes: 60,
    enabled: true,
    ...values,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  });
  return id as number;
}

type ScheduleValues = {
  scheduled_at: string;
  sent: boolean;
  discarded: boolean;
  manually_modified: boolean;
};

export async function insertSchedule(database: Knex, notificationId: number, values: Partial<ScheduleValues> = {}) {
  const [id] = await database("schedules").insert({
    notification_id: notificationId,
    scheduled_at: NOW.toISOString(),
    sent: false,
    discarded: false,
    manually_modified: false,
    ...values,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  });
  return id as number;
}

/** NOW からの相対時刻（分）を ISO 文字列で返す。 */
export function minutesFromNow(minutes: number) {
  return new Date(NOW.getTime() + minutes * 60_000).toISOString();
}

import { NextRequest } from "next/server";
import { isAdmin, unauthorized } from "@/lib/auth";
import { readyDb } from "@/lib/db";
import { latestDeliveryBySchedule } from "@/lib/delivery-summary";
import { json } from "@/lib/http";
import { dayBounds, localDateKey } from "@/lib/time";
import { generateDailySchedules } from "@/lib/scheduler";

export async function GET(request: NextRequest) {
  if (!isAdmin(request)) return unauthorized();
  const database = await readyDb();
  const { start, end } = dayBounds();
  const rows = await database("schedules as s")
    .join("notifications as n", "n.id", "s.notification_id")
    .select("s.*", "n.message")
    .where("s.scheduled_at", ">=", start.toISOString())
    .andWhere("s.scheduled_at", "<", end.toISOString())
    .orderBy("s.scheduled_at", "asc");
  // 「送信済み」の内訳（全員に成功したか）を画面で見分けられるよう、最新の送信結果の件数を添える。
  const deliveries = await latestDeliveryBySchedule(
    database,
    rows.map((row) => row.id),
  );
  return json({
    date: localDateKey(),
    schedules: rows.map((row) => ({ ...row, last_delivery: deliveries.get(row.id) ?? null })),
  });
}

export async function POST(request: NextRequest) {
  if (!isAdmin(request)) return unauthorized();
  const database = await readyDb();
  return json(await generateDailySchedules(database));
}

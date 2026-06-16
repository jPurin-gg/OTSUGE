import { NextRequest } from "next/server";
import { isAdmin, unauthorized } from "@/lib/auth";
import { readyDb } from "@/lib/db";
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
  return json({ date: localDateKey(), schedules: rows });
}

export async function POST(request: NextRequest) {
  if (!isAdmin(request)) return unauthorized();
  const database = await readyDb();
  return json(await generateDailySchedules(database));
}

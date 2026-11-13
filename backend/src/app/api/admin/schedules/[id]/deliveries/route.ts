import { NextRequest } from "next/server";
import { isAdmin, unauthorized } from "@/lib/auth";
import { readyDb } from "@/lib/db";
import { json } from "@/lib/http";

type Context = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, context: Context) {
  if (!isAdmin(request)) return unauthorized();
  const { id } = await context.params;
  const database = await readyDb();
  const schedule = await database("schedules").where({ id: Number(id) })
    .select("id", "delivery_status", "delivery_deadline_at").first();
  if (!schedule) return json({ error: "通知予定が見つかりません。" }, { status: 404 });
  const deliveries = await database("schedule_deliveries").where({ schedule_id: schedule.id }).orderBy("id");
  return json({ schedule, deliveries });
}

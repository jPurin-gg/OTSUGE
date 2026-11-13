import { readyDb } from "@/lib/db";
import { handleError, json } from "@/lib/http";
import { dayBounds, localDateKey } from "@/lib/time";

export async function GET() {
  try {
    const database = await readyDb();
    const { start, end } = dayBounds();
    const rows = await database("schedules as s")
      .join("notifications as n", "n.id", "s.notification_id")
      .select("s.id", "s.scheduled_at", "s.sent", "s.discarded", "n.message")
      .where("s.scheduled_at", ">=", start.toISOString())
      .andWhere("s.scheduled_at", "<", end.toISOString())
      .orderBy("s.scheduled_at", "asc");
    return json({ date: localDateKey(), schedules: rows });
  } catch (error) {
    return handleError(error);
  }
}

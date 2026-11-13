import { readyDb } from "@/lib/db";
import { json } from "@/lib/http";
import { dayBounds, localDateKey } from "@/lib/time";

export async function GET() {
  const database = await readyDb();
  const { start, end } = dayBounds();
  const rows = await database("schedules as s")
    .join("notifications as n", "n.id", "s.notification_id")
    .select("s.id", "s.scheduled_at", "s.sent", "s.discarded", "n.message")
    .where("s.scheduled_at", ">=", start.toISOString())
    .andWhere("s.scheduled_at", "<", end.toISOString())
    // 無効なお告げは配信の対象外なので、届かない予定（未送信・破棄）は利用者に見せない。
    // 無効にする前に届いた分は、届いた事実として残す。
    .andWhere((query) => {
      query.where("n.enabled", true).orWhere((delivered) => {
        delivered.where("s.sent", true).andWhere("s.discarded", false);
      });
    })
    .orderBy("s.scheduled_at", "asc");
  return json({ date: localDateKey(), schedules: rows });
}

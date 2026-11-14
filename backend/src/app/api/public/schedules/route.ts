import { readyDb } from "@/lib/db";
import { deliveryOutcome, latestDeliveryBySchedule } from "@/lib/delivery-summary";
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
    .orderBy("s.scheduled_at", "asc");
  // 公開 API なので件数（購読者数が分かる値）は返さず、届いたかどうかの区分だけを添える。
  const deliveries = await latestDeliveryBySchedule(
    database,
    rows.map((row) => row.id),
  );
  return json({
    date: localDateKey(),
    schedules: rows.map((row) => {
      const delivery = deliveries.get(row.id);
      return { ...row, delivery_outcome: delivery ? deliveryOutcome(delivery) : null };
    }),
  });
}

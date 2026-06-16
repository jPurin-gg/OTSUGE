import webpush from "web-push";
import type { Knex } from "knex";

function configure() {
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT;
  if (!publicKey || !privateKey || !subject) throw new Error("VAPID環境変数が設定されていません。");
  webpush.setVapidDetails(subject, publicKey, privateKey);
}

export async function sendSchedule(database: Knex, scheduleId: number) {
  configure();
  const schedule = await database("schedules as s")
    .join("notifications as n", "n.id", "s.notification_id")
    .select("s.*", "n.message")
    .where("s.id", scheduleId)
    .first();
  if (!schedule) throw new Error("通知予定が見つかりません。");

  const subscriptions = await database("subscriptions").select("*");
  let delivered = 0;
  for (const subscription of subscriptions) {
    try {
      await webpush.sendNotification(
        {
          endpoint: subscription.endpoint,
          keys: { p256dh: subscription.p256dh, auth: subscription.auth },
        },
        JSON.stringify({
          title: "OTSUGE",
          body: schedule.message,
          url: "/",
          tag: `otsuge-${schedule.id}`,
        }),
      );
      delivered += 1;
    } catch (error) {
      const statusCode = (error as { statusCode?: number }).statusCode;
      if (statusCode === 404 || statusCode === 410) {
        await database("subscriptions").where({ id: subscription.id }).delete();
      } else {
        console.error("Push delivery failed", error);
      }
    }
  }

  await database("schedules").where({ id: scheduleId }).update({
    sent: true,
    discarded: false,
    updated_at: new Date().toISOString(),
  });
  return { delivered };
}

export async function dispatchDueSchedules(database: Knex) {
  const now = new Date();
  const overdue = new Date(now.getTime() - 30 * 60 * 1000);
  const discarded = await database("schedules")
    .where({ sent: false })
    .andWhere("scheduled_at", "<=", overdue.toISOString())
    .update({ sent: true, discarded: true, updated_at: now.toISOString() });

  const due = await database("schedules")
    .where({ sent: false })
    .andWhere("scheduled_at", "<=", now.toISOString())
    .andWhere("scheduled_at", ">", overdue.toISOString())
    .select("id");
  let delivered = 0;
  for (const schedule of due) {
    const result = await sendSchedule(database, schedule.id);
    delivered += result.delivered;
  }
  return { processed: due.length, delivered, discarded };
}

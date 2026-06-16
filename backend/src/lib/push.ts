import webpush from "web-push";
import type { Knex } from "knex";

type ScheduleWithMessage = {
  id: number;
  scheduled_at: string;
  message: string;
};

function configure() {
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT;
  if (!publicKey || !privateKey || !subject) throw new Error("VAPID環境変数が設定されていません。");
  webpush.setVapidDetails(subject, publicKey, privateKey);
}

export async function sendSchedule(database: Knex, scheduleId: number) {
  configure();
  const schedule = (await database("schedules as s")
    .join("notifications as n", "n.id", "s.notification_id")
    .select("s.*", "n.message")
    .where("s.id", scheduleId)
    .first()) as ScheduleWithMessage | undefined;
  if (!schedule) throw new Error("通知予定が見つかりません。");

  const subscriptions = await database("subscriptions").select("*");
  let delivered = 0;
  let failed = 0;
  let removed = 0;
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
      failed += 1;
      if (statusCode === 404 || statusCode === 410) {
        await database("subscriptions").where({ id: subscription.id }).delete();
        removed += 1;
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
  await insertDeliveryLog(database, {
    schedule_id: schedule.id,
    status: "sent",
    message: schedule.message,
    scheduled_at: schedule.scheduled_at,
    sent_at: new Date().toISOString(),
    delivered_count: delivered,
    failed_count: failed,
    removed_subscription_count: removed,
  });
  return { delivered, failed, removed };
}

export async function dispatchDueSchedules(database: Knex) {
  const now = new Date();
  const overdue = new Date(now.getTime() - 30 * 60 * 1000);

  const overdueSchedules = (await database("schedules as s")
    .join("notifications as n", "n.id", "s.notification_id")
    .select("s.id", "s.scheduled_at", "n.message")
    .where({ sent: false })
    .andWhere("scheduled_at", "<=", overdue.toISOString())
    .orderBy("s.scheduled_at", "asc")) as ScheduleWithMessage[];

  if (overdueSchedules.length > 0) {
    await database("schedules")
      .whereIn(
        "id",
        overdueSchedules.map((schedule) => schedule.id),
      )
      .update({ sent: true, discarded: true, updated_at: now.toISOString() });
    await database("delivery_logs").insert(
      overdueSchedules.map((schedule) => ({
        schedule_id: schedule.id,
        status: "discarded",
        message: schedule.message,
        scheduled_at: schedule.scheduled_at,
        sent_at: now.toISOString(),
        delivered_count: 0,
        failed_count: 0,
        removed_subscription_count: 0,
        created_at: now.toISOString(),
      })),
    );
  }

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
  return { processed: due.length, delivered, discarded: overdueSchedules.length };
}

async function insertDeliveryLog(
  database: Knex,
  input: {
    schedule_id: number;
    status: "sent" | "discarded";
    message: string;
    scheduled_at: string;
    sent_at: string;
    delivered_count: number;
    failed_count: number;
    removed_subscription_count: number;
  },
) {
  await database("delivery_logs").insert({
    ...input,
    created_at: input.sent_at,
  });
}

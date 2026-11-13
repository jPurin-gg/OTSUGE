import webpush from "web-push";
import type { Knex } from "knex";
import type { DeliveryStatus, ScheduleDeliveryRecord, ScheduleRecord } from "./types";

type ScheduleWithMessage = ScheduleRecord & { message: string };
type DeliveryWithSubscription = ScheduleDeliveryRecord & {
  endpoint: string | null;
  p256dh: string | null;
  auth: string | null;
};

const DELIVERY_WINDOW_MS = 30 * 60 * 1000;
const MINUTE_MS = 60 * 1000;

function configure() {
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT;
  if (!publicKey || !privateKey || !subject) throw new Error("VAPID環境変数が設定されていません。");
  webpush.setVapidDetails(subject, publicKey, privateKey);
}

function pushFailure(error: unknown) {
  const { statusCode, code } = (error ?? {}) as { statusCode?: number; code?: string };
  const removed = statusCode === 404 || statusCode === 410;
  const retryable = statusCode == null || statusCode === 408 || statusCode === 429 || (statusCode >= 500 && statusCode <= 599);
  // WebPushError の本文・endpoint・鍵などは保存しない。
  const networkCodes = ["ETIMEDOUT", "ECONNRESET", "ECONNREFUSED", "EAI_AGAIN", "ENOTFOUND", "EHOSTUNREACH", "ENETUNREACH", "EPIPE"];
  const lastError = typeof statusCode === "number"
    ? `HTTP ${statusCode}`
    : networkCodes.includes(code ?? "") ? `NETWORK ${code}` : "NETWORK_ERROR";
  return { removed, retryable, lastError };
}

const isPending = (delivery: ScheduleDeliveryRecord) => delivery.status === "pending" || delivery.status === "retrying";

async function discardDelivery(database: Knex, delivery: ScheduleDeliveryRecord, now: Date) {
  await database("schedule_deliveries").where({ id: delivery.id }).update({
    status: "discarded",
    attempt_count: delivery.attempt_count,
    last_error: delivery.last_error ?? "DELIVERY_DEADLINE_EXCEEDED",
    next_attempt_at: null,
    updated_at: now.toISOString(),
  });
}

export async function sendSchedule(database: Knex, scheduleId: number) {
  const found = (await database("schedules as s")
    .join("notifications as n", "n.id", "s.notification_id")
    .select("s.*", "n.message")
    .where("s.id", scheduleId)
    .first()) as ScheduleWithMessage | undefined;
  if (!found) throw new Error("通知予定が見つかりません。");
  let schedule: ScheduleWithMessage = found;
  if (schedule.sent) {
    return { delivered: 0, failed: 0, removed: 0, pending: 0, status: schedule.delivery_status, processed: false, expired: false };
  }

  let changed = false;
  if (!schedule.delivery_deadline_at) {
    const now = new Date();
    // 即時送信も30分以内とし、後から予定時刻が変更されても期限を延長しない。
    const deadline = new Date(Math.min(new Date(schedule.scheduled_at).getTime(), now.getTime()) + DELIVERY_WINDOW_MS).toISOString();
    changed = await database.transaction(async (transaction) => {
      const initialized = await transaction("schedules").where({ id: scheduleId }).whereNull("delivery_deadline_at")
        .update({ delivery_deadline_at: deadline, updated_at: now.toISOString() });
      if (!initialized) return false;
      const subscriptions = await transaction("subscriptions").select("id");
      if (subscriptions.length) {
        await transaction.batchInsert("schedule_deliveries", subscriptions.map((subscription) => ({
          schedule_id: scheduleId,
          subscription_id: subscription.id,
          status: "pending",
          attempt_count: 0,
          next_attempt_at: now.toISOString(),
          created_at: now.toISOString(),
          updated_at: now.toISOString(),
        })), 100);
      }
      return true;
    });
    schedule = { ...schedule, ...await database("schedules").where({ id: scheduleId }).first() };
  }

  const deadline = new Date(schedule.delivery_deadline_at!).getTime();
  const deliveries = (await database("schedule_deliveries as d")
    .leftJoin("subscriptions as s", "s.id", "d.subscription_id")
    .where("d.schedule_id", scheduleId)
    .select("d.*", "s.endpoint", "s.p256dh", "s.auth")
    .orderBy("d.id")) as DeliveryWithSubscription[];
  let delivered = 0;
  let failed = 0;
  let removed = 0;
  let expired = false;
  let configured = false;
  for (const delivery of deliveries) {
    if (!isPending(delivery)) continue;
    const now = new Date();
    if (now.getTime() >= deadline) {
      await discardDelivery(database, delivery, now);
      changed = true;
      expired = true;
      continue;
    }
    if (delivery.next_attempt_at && new Date(delivery.next_attempt_at).getTime() > now.getTime()) continue;
    if (!delivery.endpoint) {
      await database("schedule_deliveries").where({ id: delivery.id }).update({
        status: "removed", last_error: "SUBSCRIPTION_REMOVED", next_attempt_at: null, updated_at: now.toISOString(),
      });
      changed = true;
      continue;
    }
    if (!configured) {
      configure();
      configured = true;
    }
    const attemptCount = delivery.attempt_count + 1;
    await database("schedule_deliveries").where({ id: delivery.id }).update({ attempt_count: attemptCount, updated_at: now.toISOString() });
    const sendAt = new Date();
    if (sendAt.getTime() >= deadline) {
      await discardDelivery(database, delivery, sendAt);
      changed = true;
      expired = true;
      continue;
    }
    let failure: ReturnType<typeof pushFailure> | undefined;
    try {
      await webpush.sendNotification(
        { endpoint: delivery.endpoint, keys: { p256dh: delivery.p256dh!, auth: delivery.auth! } },
        JSON.stringify({ title: "OTSUGE", body: schedule.message, url: "/", tag: `otsuge-${schedule.id}` }),
        { TTL: Math.max(0, Math.floor((deadline - sendAt.getTime()) / 1000)), timeout: 10_000 },
      );
    } catch (error) {
      failure = pushFailure(error);
    }

    // DB更新エラーをPush失敗として扱わない。成功結果は次の購読へ進む前に保存する。
    const finishedAt = new Date();
    if (!failure) {
      await database("schedule_deliveries").where({ id: delivery.id }).update({
        status: "sent", next_attempt_at: null, updated_at: finishedAt.toISOString(),
      });
      delivered += 1;
    } else {
      failed += 1;
      const retry = failure.retryable && finishedAt.getTime() < deadline;
      const status = failure.removed ? "removed" : retry ? "retrying" : failure.retryable ? "discarded" : "failed";
      // 1分、2分、4分、以後8分。期限に達した次回処理は送らず破棄する。
      const nextAttempt = retry ? new Date(Math.min(finishedAt.getTime() + MINUTE_MS * 2 ** Math.min(attemptCount - 1, 3), deadline)).toISOString() : null;
      await database.transaction(async (transaction) => {
        await transaction("schedule_deliveries").where({ id: delivery.id }).update({
          status, last_error: failure.lastError, next_attempt_at: nextAttempt, updated_at: finishedAt.toISOString(),
        });
        if (failure.removed) await transaction("subscriptions").where({ id: delivery.subscription_id }).delete();
      });
      if (failure.removed) removed += 1;
      if (status === "discarded") expired = true;
    }
    changed = true;
  }

  const results = (await database("schedule_deliveries").where({ schedule_id: scheduleId })) as ScheduleDeliveryRecord[];
  const pending = results.filter(isPending).length;
  const successCount = results.filter((delivery) => delivery.status === "sent").length;
  const failedCount = results.length - successCount - pending;
  const allDiscarded = results.length > 0 && results.every((delivery) => delivery.status === "discarded");
  const noRecipientsExpired = results.length === 0 && Date.now() >= deadline;
  const status: DeliveryStatus = pending ? "retrying"
    : failedCount ? (successCount ? "partial" : allDiscarded ? "discarded" : "failed")
      : noRecipientsExpired ? "discarded" : "sent";
  expired ||= noRecipientsExpired;
  if (changed || pending === 0) {
    const now = new Date().toISOString();
    await database.transaction(async (transaction) => {
      await transaction("schedules").where({ id: scheduleId }).update({
        sent: pending === 0, discarded: status === "discarded", delivery_status: status, updated_at: now,
      });
      await transaction("delivery_logs").insert({
        schedule_id: schedule.id,
        status,
        message: schedule.message,
        scheduled_at: schedule.scheduled_at,
        sent_at: now,
        delivered_count: successCount,
        failed_count: failedCount,
        pending_count: pending,
        removed_subscription_count: results.filter((delivery) => delivery.status === "removed").length,
        created_at: now,
      });
    });
    changed = true;
  }
  return { delivered, failed, removed, pending, status, processed: changed, expired };
}

export async function dispatchDueSchedules(database: Knex) {
  const now = new Date();
  const due = await database("schedules")
    .where({ sent: false })
    .andWhere((query) => query.where("scheduled_at", "<=", now.toISOString()).orWhereNotNull("delivery_deadline_at"))
    .orderBy("scheduled_at", "asc")
    .select("id");
  let processed = 0;
  let delivered = 0;
  let discarded = 0;
  for (const schedule of due) {
    const result = await sendSchedule(database, schedule.id);
    delivered += result.delivered;
    if (result.expired) discarded += 1;
    else if (result.processed) processed += 1;
  }
  return { processed, delivered, discarded };
}

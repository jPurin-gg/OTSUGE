import { randomUUID } from "node:crypto";
import webpush from "web-push";
import type { Knex } from "knex";

const LEASE_DURATION_MS = 5 * 60 * 1000;
const LEASE_RENEWAL_INTERVAL_MS = 60 * 1000;
const PUSH_TIMEOUT_MS = 30 * 1000;

type ScheduleWithMessage = {
  id: number;
  scheduled_at: string;
  message: string;
};

type ScheduleWindow = { through: string; after?: string };
type ScheduleLease = { schedule: ScheduleWithMessage; token: string };

function inWindow(query: Knex.QueryBuilder, window?: ScheduleWindow) {
  if (window) {
    query.andWhere("scheduled_at", "<=", window.through);
    if (window.after) query.andWhere("scheduled_at", ">", window.after);
  }
}

// The affected-row count is the ownership decision, even across processes.
async function claimSchedule(database: Knex, scheduleId: number, window?: ScheduleWindow): Promise<ScheduleLease | null> {
  const now = new Date();
  const token = randomUUID();
  const claimed = await database("schedules")
    .where({ id: scheduleId, sent: false })
    .modify(inWindow, window)
    .andWhere((query) => query.whereNull("delivery_lease_expires_at").orWhere("delivery_lease_expires_at", "<=", now.toISOString()))
    .update({
      delivery_lease_token: token,
      delivery_lease_expires_at: new Date(now.getTime() + LEASE_DURATION_MS).toISOString(),
    });
  if (!claimed) return null;

  const schedule = (await database("schedules as s")
    .join("notifications as n", "n.id", "s.notification_id")
    .select("s.id", "s.scheduled_at", "n.message")
    .where({ "s.id": scheduleId, "s.delivery_lease_token": token })
    .first()) as ScheduleWithMessage | undefined;
  if (!schedule) throw new Error("通知予定が見つかりません。");
  return { schedule, token };
}

function ownedSchedule(database: Knex, lease: ScheduleLease, now: Date) {
  return database("schedules")
    .where({ id: lease.schedule.id, sent: false, delivery_lease_token: lease.token })
    .andWhere("delivery_lease_expires_at", ">", now.toISOString());
}

async function renewLease(database: Knex, lease: ScheduleLease) {
  const now = new Date();
  const renewed = await ownedSchedule(database, lease, now).update({
    delivery_lease_expires_at: new Date(now.getTime() + LEASE_DURATION_MS).toISOString(),
  });
  if (!renewed) throw new Error("通知予定の送信 lease を失いました。");
}

async function completeSchedule(
  database: Knex,
  lease: ScheduleLease,
  status: "sent" | "discarded",
  counts = { delivered: 0, failed: 0, removed: 0 },
) {
  // Commit the terminal state and log together. A stale owner cannot complete
  // another worker's claim, or release its lease.
  await database.transaction(async (transaction) => {
    const now = new Date();
    const completed = await ownedSchedule(transaction, lease, now).update({
      sent: true,
      discarded: status === "discarded",
      delivery_lease_token: null,
      delivery_lease_expires_at: null,
      updated_at: now.toISOString(),
    });
    if (!completed) throw new Error("通知予定の送信 lease を失いました。");
    await insertDeliveryLog(transaction, {
      schedule_id: lease.schedule.id,
      status,
      message: lease.schedule.message,
      scheduled_at: lease.schedule.scheduled_at,
      sent_at: now.toISOString(),
      delivered_count: counts.delivered,
      failed_count: counts.failed,
      removed_subscription_count: counts.removed,
    });
  });
}

function configure() {
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT;
  if (!publicKey || !privateKey || !subject) throw new Error("VAPID環境変数が設定されていません。");
  webpush.setVapidDetails(subject, publicKey, privateKey);
}

export async function sendSchedule(database: Knex, scheduleId: number) {
  const lease = await claimSchedule(database, scheduleId);
  if (!lease) {
    if (!(await database("schedules").where({ id: scheduleId }).first("id"))) {
      throw new Error("通知予定が見つかりません。");
    }
    return null;
  }
  return sendClaimedSchedule(database, lease);
}

async function sendClaimedSchedule(database: Knex, lease: ScheduleLease) {
  let heartbeatFailure: unknown;
  let pendingRenewal: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (pendingRenewal || heartbeatFailure) return;
    pendingRenewal = renewLease(database, lease)
      .catch((error: unknown) => { heartbeatFailure = error; })
      .finally(() => { pendingRenewal = undefined; });
  }, LEASE_RENEWAL_INTERVAL_MS);
  timer.unref();
  const stopHeartbeat = async () => {
    clearInterval(timer);
    await pendingRenewal;
    if (heartbeatFailure) throw heartbeatFailure;
  };
  try {
    const counts = await deliverSchedule(database, lease, () => {
      if (heartbeatFailure) throw heartbeatFailure;
    });
    await stopHeartbeat();
    // If a worker stops after Push acceptance, recovery can send again. A lease
    // prevents concurrent ownership; it is not an exactly-once guarantee.
    await completeSchedule(database, lease, "sent", counts);
    return counts;
  } finally {
    clearInterval(timer);
    await pendingRenewal;
  }
}

async function deliverSchedule(database: Knex, lease: ScheduleLease, checkHeartbeat: () => void) {
  configure();
  const { schedule } = lease;

  const subscriptions = await database("subscriptions").select("*");
  let delivered = 0;
  let failed = 0;
  let removed = 0;
  for (const subscription of subscriptions) {
    // Recheck ownership before each request, including after a paused worker.
    // The heartbeat also renews while awaiting a slow Push response.
    checkHeartbeat();
    await renewLease(database, lease);
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
        { timeout: PUSH_TIMEOUT_MS },
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

  return { delivered, failed, removed };
}

export async function dispatchDueSchedules(database: Knex) {
  const now = new Date();
  const overdue = new Date(now.getTime() - 30 * 60 * 1000);

  const overdueSchedules = await database("schedules")
    .where({ sent: false })
    .andWhere("scheduled_at", "<=", overdue.toISOString())
    .orderBy("scheduled_at", "asc")
    .select("id");

  let discarded = 0;
  for (const schedule of overdueSchedules) {
    const lease = await claimSchedule(database, schedule.id, { through: overdue.toISOString() });
    if (!lease) continue;
    await completeSchedule(database, lease, "discarded");
    discarded += 1;
  }

  const due = await database("schedules")
    .where({ sent: false })
    .andWhere("scheduled_at", "<=", now.toISOString())
    .andWhere("scheduled_at", ">", overdue.toISOString())
    .select("id");
  let delivered = 0;
  let processed = 0;
  for (const schedule of due) {
    const lease = await claimSchedule(database, schedule.id, { through: now.toISOString(), after: overdue.toISOString() });
    if (!lease) continue;
    const result = await sendClaimedSchedule(database, lease);
    processed += 1;
    delivered += result.delivered;
  }
  return { processed, delivered, discarded };
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

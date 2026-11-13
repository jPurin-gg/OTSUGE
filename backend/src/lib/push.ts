import { Agent } from "node:https";
import { performance } from "node:perf_hooks";
import webpush from "web-push";
import type { Knex } from "knex";

export const DISPATCH_LIMITS = {
  expiryMs: 30 * 60 * 1000,
  concurrency: 5,
  maxSchedules: 20,
  maxPushRequests: 200,
  requestTimeoutMs: 5_000,
  runTimeoutMs: 45_000,
} as const;

type ScheduleWithMessage = {
  id: number;
  scheduled_at: string | Date;
  message: string;
};
type Subscription = { id: number; endpoint: string; p256dh: string; auth: string };
type Progress = {
  schedule_id: number;
  immediate: boolean | number;
  subscription_cursor: number;
  subscription_limit: number;
  delivered_count: number;
  failed_count: number;
  removed_subscription_count: number;
};
type Budget = { deadline: number; remainingRequests: number };
type Result = { delivered: number; failed: number; removed: number; pending: boolean; discarded: boolean };

function createBudget(): Budget {
  return { deadline: performance.now() + DISPATCH_LIMITS.runTimeoutMs, remainingRequests: DISPATCH_LIMITS.maxPushRequests };
}

function configure() {
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  const privateKey = process.env.VAPID_PRIVATE_KEY;
  const subject = process.env.VAPID_SUBJECT;
  if (!publicKey || !privateKey || !subject) throw new Error("VAPID環境変数が設定されていません。");
  webpush.setVapidDetails(subject, publicKey, privateKey);
}

async function sendPush(subscription: Subscription, payload: string, timeout: number) {
  // web-push の timeout はソケットの無通信時間。応答全体にも上限を設け、
  // DNS待ちや少量ずつ返る応答でも接続を破棄して次の購読へ進める。
  const agent = new Agent({ keepAlive: false });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      webpush.sendNotification(
        { endpoint: subscription.endpoint, keys: { p256dh: subscription.p256dh, auth: subscription.auth } },
        payload,
        { timeout, agent },
      ),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("Push request timed out")), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
    agent.destroy();
  }
}

// 管理者の明示操作は30分破棄を適用しない。途中で上限に達した場合も、
// immediate を保存し、次回の dispatch で同じ方針のまま未処理分を継続する。
export async function sendSchedule(database: Knex, scheduleId: number) {
  const { delivered, failed, removed, pending } = await processSchedule(database, scheduleId, true, createBudget());
  return { delivered, failed, removed, pending };
}

async function processSchedule(database: Knex, scheduleId: number, immediate: boolean, budget: Budget): Promise<Result> {
  const schedule = (await database("schedules as s")
    .join("notifications as n", "n.id", "s.notification_id")
    .select("s.id", "s.scheduled_at", "n.message")
    .where("s.id", scheduleId)
    .first()) as ScheduleWithMessage | undefined;
  if (!schedule) throw new Error("通知予定が見つかりません。");

  let progress = await database<Progress>("dispatch_progress").where({ schedule_id: scheduleId }).first();
  immediate ||= Boolean(progress?.immediate);
  const expiresAt = new Date(schedule.scheduled_at).getTime() + DISPATCH_LIMITS.expiryMs;
  const result: Result = { delivered: 0, failed: 0, removed: 0, pending: false, discarded: false };
  const expired = () => !immediate && Date.now() >= expiresAt;
  if (expired()) {
    await finishSchedule(database, schedule, progress, true);
    return { ...result, discarded: true };
  }
  if (progress && immediate && !progress.immediate) {
    await database("dispatch_progress").where({ schedule_id: scheduleId }).update({ immediate: true });
    progress.immediate = true;
  }

  if (!progress) {
    const last = await database("subscriptions").max<{ id: number | null }>({ id: "id" }).first();
    const initial: Progress = {
      schedule_id: scheduleId,
      immediate,
      subscription_cursor: 0,
      subscription_limit: Number(last?.id ?? 0),
      delivered_count: 0,
      failed_count: 0,
      removed_subscription_count: 0,
    };
    // DB待ちで時間枠を使い切っても、即時送信の方針は継続分へ残す。
    await database.transaction(async (trx) => {
      await trx("dispatch_progress").insert(initial);
      await trx("schedules").where({ id: scheduleId }).update({ sent: false, discarded: false });
    });
    progress = initial;
  }

  let configured = false;
  while (true) {
    // DB読取待ち、先行予定、先行購読の送信中にも期限は進む。
    if (expired()) {
      await finishSchedule(database, schedule, progress, true);
      return { ...result, discarded: true };
    }
    if (budget.remainingRequests <= 0 || performance.now() >= budget.deadline) {
      return { ...result, pending: true };
    }
    const subscriptions = await database<Subscription>("subscriptions")
      .where("id", ">", progress.subscription_cursor)
      .andWhere("id", "<=", progress.subscription_limit)
      .orderBy("id", "asc")
      .limit(Math.min(DISPATCH_LIMITS.concurrency, budget.remainingRequests));
    if (expired()) {
      await finishSchedule(database, schedule, progress, true);
      return { ...result, discarded: true };
    }
    if (subscriptions.length === 0) {
      await finishSchedule(database, schedule, progress, false);
      return result;
    }

    const payload = JSON.stringify({ title: "OTSUGE", body: schedule.message, url: "/", tag: `otsuge-${schedule.id}` });
    const outcomes = await Promise.all(subscriptions.map(async (subscription) => {
      const remaining = Math.min(budget.deadline - performance.now(), immediate ? Infinity : expiresAt - Date.now());
      // 1ms未満の残り時間で timeout=0（上限なし）を渡さない。
      const timeout = Math.floor(Math.min(DISPATCH_LIMITS.requestTimeoutMs, remaining));
      if (timeout < 1) return undefined;
      if (!configured) {
        configure();
        configured = true;
      }
      budget.remainingRequests -= 1;
      try {
        await sendPush(subscription, payload, timeout);
        return { id: subscription.id, delivered: 1, failed: 0, removed: 0 };
      } catch (error) {
        const statusCode = (error as { statusCode?: number }).statusCode;
        const removed = statusCode === 404 || statusCode === 410 ? 1 : 0;
        if (removed) await database("subscriptions").where({ id: subscription.id }).delete();
        // endpointやPush応答本文をログへ出さない。
        else console.error("Push delivery failed", { statusCode: statusCode ?? "network/timeout" });
        return { id: subscription.id, delivered: 0, failed: 1, removed };
      }
    }));

    for (const outcome of outcomes) {
      if (!outcome) continue;
      progress.subscription_cursor = outcome.id;
      progress.delivered_count += outcome.delivered;
      progress.failed_count += outcome.failed;
      progress.removed_subscription_count += outcome.removed;
      result.delivered += outcome.delivered;
      result.failed += outcome.failed;
      result.removed += outcome.removed;
    }
    await database("dispatch_progress").where({ schedule_id: scheduleId }).update(progress);
    if (outcomes.some((outcome) => !outcome)) {
      if (expired()) {
        await finishSchedule(database, schedule, progress, true);
        return { ...result, discarded: true };
      }
      return { ...result, pending: true };
    }
    // 最後のバッチが上限と一致しても、完了した予定は次回へ残さない。
    const next = await database("subscriptions")
      .where("id", ">", progress.subscription_cursor)
      .andWhere("id", "<=", progress.subscription_limit)
      .first("id");
    if (!next) {
      await finishSchedule(database, schedule, progress, false);
      return result;
    }
  }
}

export async function dispatchDueSchedules(database: Knex) {
  const budget = createBudget();
  const due = await database("schedules as s")
    .leftJoin("dispatch_progress as p", "p.schedule_id", "s.id")
    .where(function () {
      this.where(function () {
        this.where("s.sent", false).andWhere("s.scheduled_at", "<=", new Date().toISOString());
      }).orWhere("p.immediate", true);
    })
    .select("s.id")
    .orderBy("s.scheduled_at", "asc")
    .orderBy("s.id", "asc")
    .limit(DISPATCH_LIMITS.maxSchedules);
  let processed = 0;
  let delivered = 0;
  let discarded = 0;
  for (const schedule of due) {
    const result = await processSchedule(database, schedule.id, false, budget);
    delivered += result.delivered;
    if (result.discarded) discarded += 1;
    else if (!result.pending || result.delivered + result.failed > 0) processed += 1;
  }
  return { processed, delivered, discarded };
}

async function finishSchedule(database: Knex, schedule: ScheduleWithMessage, progress: Progress | undefined, discarded: boolean) {
  const now = new Date().toISOString();
  await database.transaction(async (trx) => {
    await trx("schedules").where({ id: schedule.id }).update({ sent: true, discarded, updated_at: now });
    await trx("delivery_logs").insert({
      schedule_id: schedule.id,
      status: discarded ? "discarded" : "sent",
      message: schedule.message,
      scheduled_at: schedule.scheduled_at,
      sent_at: now,
      delivered_count: progress?.delivered_count ?? 0,
      failed_count: progress?.failed_count ?? 0,
      removed_subscription_count: progress?.removed_subscription_count ?? 0,
      created_at: now,
    });
    await trx("dispatch_progress").where({ schedule_id: schedule.id }).delete();
  });
}

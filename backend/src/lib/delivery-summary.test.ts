import assert from "node:assert/strict";
import test, { after, before, beforeEach } from "node:test";
import type { Knex } from "knex";

// db.ts は読み込み時に接続先を決めるので、環境変数を設定してから読み込む。
process.env.SQLITE_PATH = ":memory:";
process.env.APP_TIMEZONE = "Asia/Tokyo";

// Asia/Tokyo の 2026-11-14 12:00。
const NOW = new Date("2026-11-14T03:00:00.000Z");

let database: Knex;
let summary: typeof import("./delivery-summary");

before(async () => {
  const { readyDb } = await import("./db");
  database = await readyDb();
  summary = await import("./delivery-summary");
});

// 接続を閉じないと、テストのプロセスが終了しない。
after(async () => {
  await database.destroy();
});

beforeEach(async () => {
  await database("delivery_logs").delete();
  await database("schedules").delete();
  await database("notifications").delete();
});

async function insertSchedule() {
  const [notificationId] = await database("notifications").insert({
    message: "水を飲め",
    start_time: "09:00",
    end_time: "22:00",
    count_per_day: 1,
    min_interval_minutes: 60,
    enabled: true,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  });
  const [id] = await database("schedules").insert({
    notification_id: notificationId,
    scheduled_at: NOW.toISOString(),
    sent: true,
    discarded: false,
    manually_modified: false,
    created_at: NOW.toISOString(),
    updated_at: NOW.toISOString(),
  });
  return id as number;
}

async function insertLog(values: {
  schedule_id?: number | null;
  status?: "sent" | "discarded";
  sent_at: string;
  delivered?: number;
  failed?: number;
  removed?: number;
}) {
  await database("delivery_logs").insert({
    schedule_id: values.schedule_id ?? null,
    status: values.status ?? "sent",
    message: "水を飲め",
    scheduled_at: values.sent_at,
    sent_at: values.sent_at,
    delivered_count: values.delivered ?? 0,
    failed_count: values.failed ?? 0,
    removed_subscription_count: values.removed ?? 0,
    created_at: values.sent_at,
  });
}

test("配信結果を「全員に成功 / 一部失敗 / 全件失敗 / 対象なし」に分ける", () => {
  assert.equal(summary.deliveryOutcome({ delivered_count: 3, failed_count: 0 }), "delivered");
  assert.equal(summary.deliveryOutcome({ delivered_count: 2, failed_count: 1 }), "partial");
  assert.equal(summary.deliveryOutcome({ delivered_count: 0, failed_count: 3 }), "failed");
  assert.equal(summary.deliveryOutcome({ delivered_count: 0, failed_count: 0 }), "no_target");
});

test("今日の送信数は、送信ログ一覧の上限（50件）を超えても数える", async () => {
  for (let index = 0; index < 60; index += 1) {
    await insertLog({ sent_at: new Date(NOW.getTime() - index * 60_000).toISOString(), delivered: 1 });
  }
  const stats = await summary.todayDeliveryStats(database, NOW);
  assert.equal(stats.todaySentCount, 60);
  assert.equal(stats.todayUndeliveredCount, 0);
});

test("今日の集計は APP_TIMEZONE の日付で区切り、破棄は送信に数えない", async () => {
  // 2026-11-14 00:00 JST = 2026-11-13T15:00:00Z
  await insertLog({ sent_at: "2026-11-13T14:59:00.000Z", delivered: 0, failed: 2 }); // 昨日 23:59
  await insertLog({ sent_at: "2026-11-13T15:00:00.000Z", delivered: 2 }); // 今日 00:00
  await insertLog({ sent_at: "2026-11-14T02:00:00.000Z", delivered: 1, failed: 1, removed: 1 }); // 一部失敗
  await insertLog({ sent_at: "2026-11-14T02:10:00.000Z", delivered: 0, failed: 3 }); // 全件失敗
  await insertLog({ sent_at: "2026-11-14T02:20:00.000Z" }); // 対象なし
  await insertLog({ sent_at: "2026-11-14T02:30:00.000Z", status: "discarded" });
  await insertLog({ sent_at: "2026-11-14T15:00:00.000Z", delivered: 1 }); // 明日 00:00

  const stats = await summary.todayDeliveryStats(database, NOW);
  assert.deepEqual(stats, { todaySentCount: 4, todayUndeliveredCount: 3 });
});

test("予定ごとに、いちばん新しい送信結果の件数を返す", async () => {
  const resent = await insertSchedule();
  const failedOnly = await insertSchedule();
  const discarded = await insertSchedule();
  const noLog = await insertSchedule();
  await insertLog({ schedule_id: resent, sent_at: "2026-11-14T01:00:00.000Z", delivered: 0, failed: 2 });
  await insertLog({ schedule_id: resent, sent_at: "2026-11-14T02:00:00.000Z", delivered: 2 });
  await insertLog({ schedule_id: failedOnly, sent_at: "2026-11-14T02:00:00.000Z", failed: 3, removed: 1 });
  await insertLog({ schedule_id: discarded, sent_at: "2026-11-14T02:00:00.000Z", status: "discarded" });

  const latest = await summary.latestDeliveryBySchedule(database, [resent, failedOnly, discarded, noLog]);
  assert.deepEqual(latest.get(resent), { delivered_count: 2, failed_count: 0, removed_subscription_count: 0 });
  assert.deepEqual(latest.get(failedOnly), { delivered_count: 0, failed_count: 3, removed_subscription_count: 1 });
  assert.equal(latest.has(discarded), false);
  assert.equal(latest.has(noLog), false);
  assert.equal((await summary.latestDeliveryBySchedule(database, [])).size, 0);
});

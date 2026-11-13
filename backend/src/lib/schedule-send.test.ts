import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test, { after, before, beforeEach, mock } from "node:test";
import type { Knex } from "knex";
import { NextRequest } from "next/server";
import webpush from "web-push";

process.env.SQLITE_PATH = ":memory:";
process.env.APP_TIMEZONE = "Asia/Tokyo";
process.env.ADMIN_PASSWORD = "test-password";
process.env.AUTH_SECRET = "test-secret";
process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY = "test-public-key";
process.env.VAPID_PRIVATE_KEY = "test-private-key";
process.env.VAPID_SUBJECT = "mailto:test@example.invalid";

const CREATED_AT = "2026-11-13T15:00:00.000Z";
const SUBSCRIPTION_COUNT = 2;
const ADMIN_COOKIE = `otsuge_admin=${createHash("sha256").update("test-password:test-secret").digest("hex")}`;

// 実際の Push サービスへは送らない。呼ばれた回数で「送ったかどうか」を確かめる。
mock.method(webpush, "setVapidDetails", () => undefined);
const sendNotification = mock.method(webpush, "sendNotification", async () => ({
  statusCode: 201,
  headers: {},
  body: "",
}));

let database: Knex;
let notificationId: number;
let push: typeof import("./push");
let route: typeof import("../app/api/admin/schedules/[id]/send/route");

before(async () => {
  // db.ts は読み込み時に接続先を決めるので、環境変数を設定してから読み込む。
  const { readyDb } = await import("./db");
  push = await import("./push");
  route = await import("../app/api/admin/schedules/[id]/send/route");
  database = await readyDb();
  [notificationId] = await database("notifications").insert({
    message: "水を飲め",
    start_time: "09:00",
    end_time: "22:00",
    count_per_day: 1,
    min_interval_minutes: 60,
    enabled: true,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
  });
  await database("subscriptions").insert(
    Array.from({ length: SUBSCRIPTION_COUNT }, (_, index) => ({
      endpoint: `https://example.invalid/push/${index}`,
      p256dh: "test-p256dh",
      auth: "test-auth",
      created_at: CREATED_AT,
    })),
  );
});

beforeEach(async () => {
  await database("delivery_logs").delete();
  await database("schedules").delete();
  sendNotification.mock.resetCalls();
});

after(async () => {
  await database.destroy();
});

type State = "unsent" | "sent" | "discarded";

async function insertSchedule(state: State, scheduledAt = new Date().toISOString()) {
  const [id] = await database("schedules").insert({
    notification_id: notificationId,
    scheduled_at: scheduledAt,
    sent: state !== "unsent",
    discarded: state === "discarded",
    manually_modified: false,
    created_at: CREATED_AT,
    updated_at: CREATED_AT,
  });
  return id as number;
}

async function readState(id: number) {
  const row = await database("schedules").where({ id }).first();
  return { sent: Boolean(row.sent), discarded: Boolean(row.discarded) };
}

async function logCount() {
  const row = await database("delivery_logs").count<{ count: string | number }>({ count: "*" }).first();
  return Number(row?.count ?? 0);
}

const sentCount = () => sendNotification.mock.callCount();

test("sendSchedule: 未送信の予定は再送の指定なしで全購読へ送る", async () => {
  const id = await insertSchedule("unsent");
  const result = await push.sendSchedule(database, id);
  assert.deepEqual(result, { delivered: SUBSCRIPTION_COUNT, failed: 0, removed: 0 });
  assert.equal(sentCount(), SUBSCRIPTION_COUNT);
  assert.deepEqual(await readState(id), { sent: true, discarded: false });
  assert.equal(await logCount(), 1);
});

for (const state of ["sent", "discarded"] as const) {
  test(`sendSchedule: ${state} の予定は再送の指定がなければ送らない`, async () => {
    const id = await insertSchedule(state);
    assert.equal(await push.sendSchedule(database, id), null);
    assert.equal(await push.sendSchedule(database, id, { resend: false }), null);
    assert.equal(sentCount(), 0);
    assert.deepEqual(await readState(id), { sent: true, discarded: state === "discarded" });
    assert.equal(await logCount(), 0);
  });

  test(`sendSchedule: ${state} の予定は resend を明示すると送る`, async () => {
    const id = await insertSchedule(state);
    const result = await push.sendSchedule(database, id, { resend: true });
    assert.deepEqual(result, { delivered: SUBSCRIPTION_COUNT, failed: 0, removed: 0 });
    assert.equal(sentCount(), SUBSCRIPTION_COUNT);
    assert.deepEqual(await readState(id), { sent: true, discarded: false });
    assert.equal(await logCount(), 1);
  });
}

test("sendSchedule: 続けて2回呼んでも、再送の指定がなければ1回しか送らない", async () => {
  const id = await insertSchedule("unsent");
  assert.ok(await push.sendSchedule(database, id));
  assert.equal(await push.sendSchedule(database, id), null);
  assert.equal(sentCount(), SUBSCRIPTION_COUNT);
  assert.equal(await logCount(), 1);
});

test("dispatchDueSchedules: 配信時刻が来た未送信の予定だけを送り、送信済みの予定は送り直さない", async () => {
  const oneMinuteAgo = new Date(Date.now() - 60_000).toISOString();
  const due = await insertSchedule("unsent", oneMinuteAgo);
  await insertSchedule("sent", oneMinuteAgo);
  const result = await push.dispatchDueSchedules(database);
  assert.deepEqual(result, { processed: 1, delivered: SUBSCRIPTION_COUNT, discarded: 0 });
  assert.equal(sentCount(), SUBSCRIPTION_COUNT);
  assert.deepEqual(await readState(due), { sent: true, discarded: false });
});

function post(id: number, body?: string, cookie = ADMIN_COOKIE) {
  const request = new NextRequest(`http://localhost:3001/api/admin/schedules/${id}/send`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body,
  });
  return route.POST(request, { params: Promise.resolve({ id: String(id) }) });
}

test("POST send: 未送信の予定は本文なしでも送る", async () => {
  const id = await insertSchedule("unsent");
  const response = await post(id);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { delivered: SUBSCRIPTION_COUNT, failed: 0, removed: 0 });
  assert.equal(sentCount(), SUBSCRIPTION_COUNT);
});

for (const state of ["sent", "discarded"] as const) {
  test(`POST send: ${state} の予定は resend: true がなければ 409 で拒否する`, async () => {
    const id = await insertSchedule(state);
    for (const body of [undefined, "{}", JSON.stringify({ resend: false })]) {
      const response = await post(id, body);
      assert.equal(response.status, 409);
      assert.match((await response.json()).error, /再送/);
    }
    assert.equal(sentCount(), 0);
    assert.equal(await logCount(), 0);
  });

  test(`POST send: ${state} の予定は resend: true で再送する`, async () => {
    const id = await insertSchedule(state);
    const response = await post(id, JSON.stringify({ resend: true }));
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { delivered: SUBSCRIPTION_COUNT, failed: 0, removed: 0 });
    assert.equal(sentCount(), SUBSCRIPTION_COUNT);
    assert.deepEqual(await readState(id), { sent: true, discarded: false });
  });
}

test("POST send: resend が真偽値でない本文や JSON でない本文は 400 で、送信しない", async () => {
  const id = await insertSchedule("sent");
  for (const body of [JSON.stringify({ resend: "true" }), JSON.stringify({ resend: 1 }), "resend=true", "[]", "null"]) {
    const response = await post(id, body);
    assert.equal(response.status, 400, body);
  }
  assert.equal(sentCount(), 0);
});

test("POST send: 管理者のクッキーがなければ 401 で、送信しない", async () => {
  const id = await insertSchedule("unsent");
  const response = await post(id, undefined, "");
  assert.equal(response.status, 401);
  assert.equal(sentCount(), 0);
  assert.deepEqual(await readState(id), { sent: false, discarded: false });
});

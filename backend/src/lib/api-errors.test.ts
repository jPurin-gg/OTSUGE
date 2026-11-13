import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { Knex } from "knex";
import { NextRequest } from "next/server";

test("API routes hide injected database initialization and query failures", async (t) => {
  const log = t.mock.method(console, "error", () => {});
  const databaseError = new Error("SELECT * FROM subscriptions: INTERNAL_TEST_VALUE at /private/db.ts:42");
  const originalDb = global.otsugeDb;
  const originalReady = global.otsugeDbReady;
  const originalEnv = { ADMIN_PASSWORD: process.env.ADMIN_PASSWORD, AUTH_SECRET: process.env.AUTH_SECRET, CRON_SECRET: process.env.CRON_SECRET };
  process.env.ADMIN_PASSWORD = "test-admin";
  process.env.AUTH_SECRET = "test-auth";
  process.env.CRON_SECRET = "test-cron";
  global.otsugeDb = (() => { throw databaseError; }) as unknown as Knex;
  global.otsugeDbReady = Promise.resolve();
  try {
    const subscriptions = await import("../app/api/subscriptions/route");
    const publicSchedules = await import("../app/api/public/schedules/route");
    const health = await import("../app/api/health/route");
    const notifications = await import("../app/api/admin/notifications/route");
    const notification = await import("../app/api/admin/notifications/[id]/route");
    const quietHours = await import("../app/api/admin/quiet-hours/route");
    const quietHour = await import("../app/api/admin/quiet-hours/[id]/route");
    const schedules = await import("../app/api/admin/schedules/route");
    const schedule = await import("../app/api/admin/schedules/[id]/route");
    const send = await import("../app/api/admin/schedules/[id]/send/route");
    const stats = await import("../app/api/admin/stats/route");
    const logs = await import("../app/api/admin/delivery-logs/route");
    const generate = await import("../app/api/internal/generate/route");
    const dispatch = await import("../app/api/internal/dispatch/route");
    const cookie = `otsuge_admin=${createHash("sha256").update("test-admin:test-auth").digest("hex")}`;
    function request(method: string, body?: unknown) {
      return new NextRequest("http://localhost:3001/api/test", {
        method,
        headers: { cookie, authorization: "Bearer test-cron", "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    }
    const context = () => ({ params: Promise.resolve({ id: "1" }) });
    const notificationBody = { message: "水を飲め", start_time: "09:00", end_time: "18:00", count_per_day: 1, min_interval_minutes: 0, enabled: true };
    const quietBody = { start_time: "00:00", end_time: "08:00", enabled: true };
    const subscriptionBody = { endpoint: "https://example.com/push", keys: { p256dh: "test", auth: "test" } };
    const routes = [
      ["subscriptions POST", () => subscriptions.POST(request("POST", subscriptionBody))],
      ["subscriptions DELETE", () => subscriptions.DELETE(request("DELETE", { endpoint: subscriptionBody.endpoint }))],
      ["public schedules GET", () => publicSchedules.GET()],
      ["health GET", () => health.GET()],
      ["notifications GET", () => notifications.GET(request("GET"))],
      ["notifications POST", () => notifications.POST(request("POST", notificationBody))],
      ["notification PUT", () => notification.PUT(request("PUT", notificationBody), context())],
      ["notification DELETE", () => notification.DELETE(request("DELETE"), context())],
      ["quiet hours GET", () => quietHours.GET(request("GET"))],
      ["quiet hours POST", () => quietHours.POST(request("POST", quietBody))],
      ["quiet hour PUT", () => quietHour.PUT(request("PUT", quietBody), context())],
      ["quiet hour DELETE", () => quietHour.DELETE(request("DELETE"), context())],
      ["schedules GET", () => schedules.GET(request("GET"))],
      ["schedules POST", () => schedules.POST(request("POST"))],
      ["schedule PUT", () => schedule.PUT(request("PUT", { scheduled_at: "2026-11-13T12:00:00Z" }), context())],
      ["schedule DELETE", () => schedule.DELETE(request("DELETE"), context())],
      ["send POST", () => send.POST(request("POST"), context())],
      ["stats GET", () => stats.GET(request("GET"))],
      ["delivery logs GET", () => logs.GET(request("GET"))],
      ["generate POST", () => generate.POST(request("POST"))],
      ["dispatch POST", () => dispatch.POST(request("POST"))],
    ] as const;
    const ids = new Set<string>();
    for (const [name, run] of routes) {
      await t.test(`${name}: database initialization failure`, async () => {
        global.otsugeDbReady = Promise.reject(databaseError);
        const response = await run();
        const body = await response.json();
        assert.equal(response.status, 500);
        assert.deepEqual(body, { error: `サーバーエラーが発生しました。（参照ID: ${body.requestId}）`, requestId: body.requestId });
        assert.match(body.requestId, /^[0-9a-f-]{36}$/);
        assert.equal(response.headers.get("x-request-id"), body.requestId);
        assert.deepEqual(log.mock.calls.at(-1)?.arguments, ["API request failed", { requestId: body.requestId, error: databaseError }]);
        ids.add(body.requestId);
      });
    }
    assert.equal(ids.size, routes.length);
    for (const [name, run] of routes.filter(([name]) => name !== "health GET" && name !== "send POST")) {
      await t.test(`${name}: database query failure`, async () => {
        global.otsugeDbReady = Promise.resolve();
        const response = await run();
        assert.equal(response.status, 500);
        const body = await response.json();
        assert.deepEqual(body, { error: `サーバーエラーが発生しました。（参照ID: ${body.requestId}）`, requestId: body.requestId });
        assert.deepEqual(log.mock.calls.at(-1)?.arguments, ["API request failed", { requestId: body.requestId, error: databaseError }]);
      });
    }
    await t.test("invalid subscription keeps field details before accessing the database", async () => {
      const beforeLogs = log.mock.callCount();
      const response = await subscriptions.POST(request("POST", { endpoint: "invalid", keys: {} }));
      const body = await response.json();
      assert.equal(response.status, 400);
      assert.equal(body.error, "入力内容が不正です。");
      assert.deepEqual(body.details.map((issue: { path: string[] }) => issue.path), [["endpoint"], ["keys", "p256dh"], ["keys", "auth"]]);
      assert.equal(log.mock.callCount(), beforeLogs);
    });
  } finally {
    global.otsugeDb = originalDb;
    global.otsugeDbReady = originalReady;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

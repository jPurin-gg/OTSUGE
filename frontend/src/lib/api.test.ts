import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { api, ApiError, describeDetails, describeError, isUnauthorized, NETWORK_ERROR_MESSAGE } from "./api";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function respondWith(status: number, body: unknown) {
  globalThis.fetch = async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });
}

async function captureError(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  assert.fail("api() should have thrown");
}

test("api() returns the parsed body on 2xx", async () => {
  respondWith(200, { ok: true });
  assert.deepEqual(await api("/api/admin/stats"), { ok: true });
});

test("api() keeps the HTTP status and details on 400", async () => {
  const details = [{ origin: "string", code: "too_big", maximum: 200, path: ["message"], message: "Too big" }];
  respondWith(400, { error: "入力内容が不正です。", details });
  const error = await captureError(api("/api/admin/notifications", { method: "POST" }));
  assert.ok(error instanceof ApiError);
  assert.equal(error.status, 400);
  assert.equal(error.message, "入力内容が不正です。");
  assert.deepEqual(error.details, details);
});

test("api() marks 401 so callers can send the user back to the login screen", async () => {
  respondWith(401, { error: "認証が必要です。" });
  const error = await captureError(api("/api/admin/schedules"));
  assert.equal(isUnauthorized(error), true);
  assert.equal((error as ApiError).message, "認証が必要です。");
});

test("api() keeps the server message on 500", async () => {
  respondWith(500, { error: "VAPID keys are not configured." });
  const error = await captureError(api("/api/admin/schedules/1/send", { method: "POST" }));
  assert.ok(error instanceof ApiError);
  assert.equal(error.status, 500);
  assert.equal(error.message, "VAPID keys are not configured.");
  assert.equal(isUnauthorized(error), false);
});

test("api() falls back to the status code when the error body is not JSON", async () => {
  respondWith(502, "<html>Bad Gateway</html>");
  const error = await captureError(api("/api/admin/stats"));
  assert.ok(error instanceof ApiError);
  assert.equal(error.status, 502);
  assert.match(error.message, /HTTP 502/);
});

test("api() turns a network failure into an ApiError with status 0", async () => {
  globalThis.fetch = async () => {
    throw new TypeError("fetch failed");
  };
  const error = await captureError(api("/api/admin/stats"));
  assert.ok(error instanceof ApiError);
  assert.equal(error.status, 0);
  assert.equal(error.message, NETWORK_ERROR_MESSAGE);
});

test("describeDetails() turns zod issues into per-field Japanese lines", () => {
  // backend/src/lib/validation.ts の違反で zod 4 が返す issues の形。
  const details = [
    { origin: "string", code: "too_small", minimum: 1, inclusive: true, path: ["message"], message: "Too small" },
    { origin: "string", code: "too_big", maximum: 200, inclusive: true, path: ["message"], message: "Too big" },
    { origin: "string", code: "invalid_format", format: "regex", path: ["start_time"], message: "Invalid string" },
    { origin: "number", code: "too_big", maximum: 100, inclusive: true, path: ["count_per_day"], message: "Too big" },
    { origin: "number", code: "too_small", minimum: 0, inclusive: true, path: ["min_interval_minutes"], message: "x" },
    { expected: "int", format: "safeint", code: "invalid_type", path: ["count_per_day"], message: "Invalid input" },
    { origin: "string", code: "invalid_format", format: "datetime", path: ["scheduled_at"], message: "Invalid" },
  ];
  assert.deepEqual(describeDetails(details), [
    "本文: 入力してください。",
    "本文: 200文字以内で入力してください。",
    "開始: 形式が正しくありません。",
    "1日の回数: 100以下にしてください。",
    "最低間隔（分）: 0以上にしてください。",
    "1日の回数: 値が正しくありません。",
    "配信時刻: 形式が正しくありません。",
  ]);
});

test("describeDetails() ignores details it cannot interpret", () => {
  assert.deepEqual(describeDetails(undefined), []);
  assert.deepEqual(describeDetails("oops"), []);
  assert.deepEqual(describeDetails([null, { code: "custom", path: [], message: "独自のエラー" }]), ["独自のエラー"]);
});

test("describeError() includes details after the message", () => {
  const error = new ApiError("入力内容が不正です。", 400, [
    { origin: "number", code: "too_big", maximum: 100, path: ["count_per_day"], message: "Too big" },
  ]);
  assert.equal(describeError(error), "入力内容が不正です。\n1日の回数: 100以下にしてください。");
  assert.equal(describeError(new Error("配信時刻を正しく入力してください。")), "配信時刻を正しく入力してください。");
  assert.equal(describeError("?"), "不明なエラーが発生しました。");
});

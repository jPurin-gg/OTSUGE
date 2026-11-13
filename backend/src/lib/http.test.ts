import assert from "node:assert/strict";
import test from "node:test";
import { handleError } from "./http";
import { notificationInput } from "./validation";

test("server errors expose only a generic message and a reference tied to the server log", async (t) => {
  const log = t.mock.method(console, "error", () => {});
  const databaseError = Object.assign(new Error("SELECT auth FROM subscriptions: password=INTERNAL_TEST_VALUE"), {
    stack: "Error at /private/database.ts:123",
    detail: "SQL constraint failed",
  });
  const ids = new Set<string>();
  for (const error of [databaseError, new Error("configuration INTERNAL_TEST_VALUE"), { secret: "INTERNAL_TEST_VALUE" }, "INTERNAL_TEST_VALUE", null]) {
    const response = handleError(error);
    const body = await response.json();
    assert.equal(response.status, 500);
    assert.match(body.requestId, /^[0-9a-f-]{36}$/);
    assert.deepEqual(body, {
      error: `サーバーエラーが発生しました。（参照ID: ${body.requestId}）`,
      requestId: body.requestId,
    });
    assert.equal(response.headers.get("x-request-id"), body.requestId);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(log.mock.calls.at(-1)?.arguments, ["API request failed", { requestId: body.requestId, error }]);
    ids.add(body.requestId);
  }
  assert.equal(ids.size, 5);
});

test("validation errors keep the existing 400 message and field details", async (t) => {
  const log = t.mock.method(console, "error", () => {});
  const parsed = notificationInput.safeParse({ message: "", count_per_day: 0 });
  assert.equal(parsed.success, false);
  if (parsed.success) throw new Error("invalid fixture");
  const response = handleError(parsed.error);
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: "入力内容が不正です。", details: parsed.error.issues });
  assert.equal(log.mock.callCount(), 0);
});

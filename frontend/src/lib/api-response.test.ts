import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { api, INVALID_RESPONSE_MESSAGE } from "./api";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function respondWith(status: number, body: string, contentType: string) {
  globalThis.fetch = async () => new Response(body, { status, headers: { "Content-Type": contentType } });
}

test("api() rejects a 200 response whose body is HTML instead of returning an empty object", async () => {
  respondWith(200, "<!DOCTYPE html><html><body>OTSUGE</body></html>", "text/html; charset=utf-8");
  await assert.rejects(api("/api/public/schedules"), { message: INVALID_RESPONSE_MESSAGE });
});

test("api() rejects a 200 response with an empty body", async () => {
  respondWith(200, "", "text/plain");
  await assert.rejects(api("/api/admin/schedules"), { message: INVALID_RESPONSE_MESSAGE });
});

test("api() returns the parsed body of a JSON response", async () => {
  respondWith(200, JSON.stringify({ schedules: [] }), "application/json");
  assert.deepEqual(await api("/api/public/schedules"), { schedules: [] });
});

test("api() still reports the server's error message on a failed JSON response", async () => {
  respondWith(401, JSON.stringify({ error: "認証が必要です。" }), "application/json");
  await assert.rejects(api("/api/admin/schedules"), { message: "認証が必要です。" });
});

test("api() fails on a non-JSON error response", async () => {
  respondWith(502, "<html>Bad Gateway</html>", "text/html");
  await assert.rejects(api("/api/admin/schedules"), Error);
});

import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { api } from "./api";

// 通信自体の失敗と HTTP エラーが、画面に出せる日本語の文言になることを検証する。

const NETWORK_ERROR_MESSAGE = "通信に失敗しました。ネットワークの状態を確認してください。";
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function respondWith(status: number, body: string) {
  globalThis.fetch = async () => new Response(body, { status, headers: { "Content-Type": "application/json" } });
}

test("api() は成功時に本文を返す", async () => {
  respondWith(200, JSON.stringify({ schedules: [] }));
  assert.deepEqual(await api("/api/public/schedules"), { schedules: [] });
});

for (const browserMessage of ["Failed to fetch", "Load failed"]) {
  test(`api() は通信エラー（${browserMessage}）を日本語の文言にする`, async () => {
    globalThis.fetch = async () => {
      throw new TypeError(browserMessage);
    };
    await assert.rejects(api("/api/public/schedules"), { name: "ApiError", message: NETWORK_ERROR_MESSAGE, status: 0 });
  });
}

test("api() はサーバーが返したエラー文言と HTTP ステータスを保つ", async () => {
  respondWith(500, JSON.stringify({ error: "サーバーエラーが発生しました。" }));
  await assert.rejects(api("/api/public/schedules"), {
    name: "ApiError",
    message: "サーバーエラーが発生しました。",
    status: 500,
  });
});

for (const body of ["<html>Bad Gateway</html>", "null", JSON.stringify({ error: { code: "E" } })]) {
  test(`api() は本文からエラー文言を読み取れないとき（${body}）、ステータスつきの日本語の文言にする`, async () => {
    respondWith(502, body);
    await assert.rejects(api("/api/public/schedules"), {
      name: "ApiError",
      message: "通信に失敗しました（HTTP 502）。",
      status: 502,
    });
  });
}

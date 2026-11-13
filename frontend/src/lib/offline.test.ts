import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import { api } from "./api";
import { isNetworkFailure, isOffline, reportConnectivity } from "./offline";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("isNetworkFailure() is true only when the request did not reach the server", () => {
  assert.equal(isNetworkFailure(new TypeError("Failed to fetch")), true);
  // 通信失敗を status 0 のエラーで表す実装（#14 の ApiError）も同じ扱いにする。
  assert.equal(isNetworkFailure(Object.assign(new Error("通信に失敗しました。"), { status: 0 })), true);
  assert.equal(isNetworkFailure(Object.assign(new Error("認証が必要です。"), { status: 401 })), false);
  assert.equal(isNetworkFailure(new Error("サーバーから想定外の応答が返りました。")), false);
  assert.equal(isNetworkFailure("Failed to fetch"), false);
});

test("a fetch failure inside api() is recognised as a network failure", async () => {
  globalThis.fetch = async () => {
    throw new TypeError("Failed to fetch");
  };
  const error = await api("/api/public/schedules").then(
    () => assert.fail("api() should have thrown"),
    (reason: unknown) => reason,
  );
  assert.equal(isNetworkFailure(error), true);
});

test("a request that did not reach the server marks the app offline until one succeeds", () => {
  assert.equal(isOffline(), false);
  reportConnectivity(false);
  assert.equal(isOffline(), true);
  reportConnectivity(true);
  assert.equal(isOffline(), false);
});

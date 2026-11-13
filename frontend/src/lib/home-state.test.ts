import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import {
  describeLoadError,
  failed,
  fetchTodaySchedules,
  initialLoad,
  INVALID_RESPONSE_MESSAGE,
  loaded,
  reloading,
  SUBSCRIPTION_ERROR_MESSAGE,
  subscriptionView,
  UNEXPECTED_ERROR_MESSAGE,
} from "./home-state";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

const schedule = { id: 1, scheduled_at: "2026-11-14T03:00:00.000Z", message: "水を飲め", sent: 0, discarded: 0 };

test("取得前は読み込み中で、値を持たない（空の一覧や未購読とは区別する）", () => {
  assert.deepEqual(initialLoad(), { status: "loading", value: null, error: "" });
});

test("取り直している間と失敗したときは、最後に取得できた値を残す", () => {
  const ready = loaded([schedule]);
  assert.deepEqual(reloading(ready), { status: "loading", value: [schedule], error: "" });
  assert.deepEqual(failed(reloading(ready), "通信に失敗しました。"), {
    status: "error",
    value: [schedule],
    error: "通信に失敗しました。",
  });
});

test("一度も取得できていない失敗は値を持たない", () => {
  assert.deepEqual(failed(initialLoad<boolean>(), "失敗"), { status: "error", value: null, error: "失敗" });
});

test("取り直すと前回の失敗の文言は消える", () => {
  assert.deepEqual(reloading(failed(initialLoad<boolean>(), "失敗")), { status: "loading", value: null, error: "" });
});

test("fetchTodaySchedules() は予定の配列を返す", async () => {
  globalThis.fetch = async () => Response.json({ date: "2026-11-14", schedules: [schedule] });
  assert.deepEqual(await fetchTodaySchedules(), [schedule]);
});

for (const body of ["<html>OK</html>", "null", "{}", JSON.stringify({ schedules: "none" })]) {
  test(`fetchTodaySchedules() は成功ステータスでも予定の配列がない応答（${body}）を失敗にする`, async () => {
    globalThis.fetch = async () => new Response(body, { status: 200 });
    await assert.rejects(fetchTodaySchedules(), { name: "ApiError", message: INVALID_RESPONSE_MESSAGE });
  });
}

test("describeLoadError() は api() の文言を出し、それ以外の例外の文言（英語）は出さない", async () => {
  globalThis.fetch = async () => {
    throw new TypeError("Failed to fetch");
  };
  const networkError = await fetchTodaySchedules().catch((error) => error);
  assert.equal(describeLoadError(networkError), "通信に失敗しました。ネットワークの状態を確認してください。");

  globalThis.fetch = async () => Response.json({ error: "サーバーエラーが発生しました。" }, { status: 500 });
  const serverError = await fetchTodaySchedules().catch((error) => error);
  assert.equal(describeLoadError(serverError), "サーバーエラーが発生しました。");

  assert.equal(
    describeLoadError(new TypeError("Cannot read properties of undefined (reading 'getRegistration')")),
    UNEXPECTED_ERROR_MESSAGE,
  );
  assert.equal(describeLoadError("oops"), UNEXPECTED_ERROR_MESSAGE);
});

test("購読カードは、状態が分かるまで「未設定」と表示せず、操作もさせない", () => {
  const view = subscriptionView(initialLoad());
  assert.equal(view.title, "確認中");
  assert.equal(view.canSubscribe, false);
  assert.equal(view.canUnsubscribe, false);
});

test("購読カードは、取得済みの状態に応じて表示と操作を切り替える", () => {
  assert.deepEqual(
    { ...subscriptionView(loaded(true)), description: undefined },
    { title: "受け取り中", description: undefined, canSubscribe: false, canUnsubscribe: true },
  );
  assert.deepEqual(
    { ...subscriptionView(loaded(false)), description: undefined },
    { title: "未設定", description: undefined, canSubscribe: true, canUnsubscribe: false },
  );
});

test("購読カードは、取り直している間は前回の状態を出し続ける", () => {
  assert.equal(subscriptionView(reloading(loaded(true))).title, "受け取り中");
  assert.equal(subscriptionView(reloading(loaded(false))).title, "未設定");
});

test("購読カードは、確認に失敗したら前回の状態ではなく失敗を出し、受け取りの操作は残す", () => {
  const view = subscriptionView(failed(reloading(loaded(true)), SUBSCRIPTION_ERROR_MESSAGE));
  assert.deepEqual(view, {
    title: "確認できません",
    description: SUBSCRIPTION_ERROR_MESSAGE,
    canSubscribe: true,
    canUnsubscribe: false,
  });
});

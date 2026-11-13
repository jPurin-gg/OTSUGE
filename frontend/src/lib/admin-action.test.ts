import assert from "node:assert/strict";
import test from "node:test";
import { createActionRunner, Notice, SESSION_EXPIRED_MESSAGE } from "./admin-action";
import { ApiError } from "./api";

function setup() {
  const busy: boolean[] = [];
  const notices: (Notice | null)[] = [];
  const expired: string[] = [];
  const run = createActionRunner({
    setBusy: (value) => busy.push(value),
    setNotice: (notice) => notices.push(notice),
    onSessionExpired: (reason) => expired.push(reason),
  });
  return { run, busy, notices, expired, lastNotice: () => notices.at(-1) };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test("shows the success message and toggles busy around the action", async () => {
  const { run, busy, lastNotice } = setup();
  const ok = await run({ label: "お告げの追加" }, async () => "お告げを追加しました。");
  assert.equal(ok, true);
  assert.deepEqual(busy, [true, false]);
  assert.deepEqual(lastNotice(), { kind: "success", text: "お告げを追加しました。" });
});

test("clears the previous message when a new action starts", async () => {
  const { run, notices } = setup();
  await run({ label: "読み込み" }, async () => "最新の状態にしました。");
  await run({ label: "読み込み" }, async () => undefined);
  assert.deepEqual(notices, [null, { kind: "success", text: "最新の状態にしました。" }, null]);
});

test("runs only once when triggered again while still running", async () => {
  const { run, busy } = setup();
  const gate = deferred();
  let calls = 0;
  const action = async () => {
    calls += 1;
    await gate.promise;
    return "送りました。";
  };
  const first = run({ label: "今すぐ送る" }, action);
  const second = run({ label: "今すぐ送る" }, action);
  const third = run({ label: "お告げの削除" }, action);
  assert.equal(await second, false);
  assert.equal(await third, false);
  gate.resolve();
  assert.equal(await first, true);
  assert.equal(calls, 1);
  assert.deepEqual(busy, [true, false]);

  // 終わったあとは再び実行できる。
  assert.equal(await run({ label: "今すぐ送る" }, action), true);
  assert.equal(calls, 2);
});

test("shows 400 / 500 / network errors with the operation label and details", async () => {
  const { run, lastNotice, expired } = setup();

  const invalid = new ApiError("入力内容が不正です。", 400, [
    { origin: "string", code: "too_big", maximum: 200, path: ["message"], message: "Too big" },
  ]);
  assert.equal(await run({ label: "お告げの追加" }, async () => Promise.reject(invalid)), false);
  assert.deepEqual(lastNotice(), {
    kind: "error",
    text: "お告げの追加に失敗しました。\n入力内容が不正です。\n本文: 200文字以内で入力してください。",
  });

  await run({ label: "今すぐ送る" }, async () => Promise.reject(new ApiError("VAPID keys are not configured.", 500)));
  assert.deepEqual(lastNotice(), { kind: "error", text: "今すぐ送るに失敗しました。\nVAPID keys are not configured." });

  await run({ label: "読み込み" }, async () => Promise.reject(new ApiError("通信に失敗しました。", 0)));
  assert.deepEqual(lastNotice(), { kind: "error", text: "読み込みに失敗しました。\n通信に失敗しました。" });

  assert.deepEqual(expired, []);
});

test("releases the busy state after a failure", async () => {
  const { run, busy } = setup();
  await run({ label: "読み込み" }, async () => Promise.reject(new Error("boom")));
  assert.deepEqual(busy, [true, false]);
  assert.equal(await run({ label: "読み込み" }, async () => undefined), true);
});

test("sends a 401 to the session-expired handler instead of showing it inline", async () => {
  const { run, expired, notices } = setup();
  const ok = await run({ label: "お告げの追加" }, async () => Promise.reject(new ApiError("認証が必要です。", 401)));
  assert.equal(ok, false);
  assert.deepEqual(expired, [SESSION_EXPIRED_MESSAGE]);
  assert.deepEqual(notices, [null]);
});

test("treats a 401 from the login itself as a wrong password, not a session expiry", async () => {
  const { run, expired, lastNotice } = setup();
  await run({ label: "ログイン", sessionExpiryOn401: false }, async () =>
    Promise.reject(new ApiError("パスワードが違います。", 401)),
  );
  assert.deepEqual(expired, []);
  assert.deepEqual(lastNotice(), { kind: "error", text: "ログインに失敗しました。\nパスワードが違います。" });
});

test("passes through a Notice returned by the action", async () => {
  const { run, lastNotice } = setup();
  const notice: Notice = { kind: "error", text: "保存しました。\nただし、最新の状態を読み込めませんでした。" };
  assert.equal(await run({ label: "お告げの追加" }, async () => notice), true);
  assert.deepEqual(lastNotice(), notice);
});

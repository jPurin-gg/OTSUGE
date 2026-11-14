import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ADMIN_STATUS_LABELS, HOME_STATUS_LABELS, scheduleStatus } from "./labels";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

test("予定の状態は sent / discarded から決まる（DB の 0/1 でも同じ）", () => {
  assert.equal(scheduleStatus({ sent: false, discarded: false }), "pending");
  assert.equal(scheduleStatus({ sent: 0, discarded: 0 }), "pending");
  assert.equal(scheduleStatus({ sent: true, discarded: false }), "sent");
  assert.equal(scheduleStatus({ sent: 1, discarded: 0 }), "sent");
  assert.equal(scheduleStatus({ sent: 1, discarded: 1 }), "discarded");
});

test("未送信・送信済みの呼び方はホームと管理画面で同じ", () => {
  assert.equal(HOME_STATUS_LABELS.pending, "未送信");
  assert.equal(HOME_STATUS_LABELS.sent, "送信済み");
  assert.equal(ADMIN_STATUS_LABELS.pending, HOME_STATUS_LABELS.pending);
  assert.equal(ADMIN_STATUS_LABELS.sent, HOME_STATUS_LABELS.sent);
});

test("利用者向けホームには内部用語の「破棄」を出さない", () => {
  assert.ok(!HOME_STATUS_LABELS.discarded.includes("破棄"));
  assert.equal(ADMIN_STATUS_LABELS.discarded, "破棄");
  assert.ok(!read("../app/page.tsx").includes("破棄"));
});

test("ホームは状態の文言を対応表から出し、古い呼び方を直接書かない", () => {
  const home = read("../app/page.tsx");
  assert.ok(home.includes("HOME_STATUS_LABELS"));
  assert.ok(!home.includes("待機中"));
  assert.ok(!/送信済(?!み)/.test(home));
  assert.ok(!home.includes("配信予定"));
});

test("管理画面は予定を「配信予定」と呼び、合言葉の欄に環境変数名を出さない", () => {
  const admin = read("../app/admin/page.tsx");
  assert.ok(admin.includes("ADMIN_STATUS_LABELS"));
  assert.ok(!admin.includes("今日のお告げ"));
  assert.ok(!admin.includes("ADMIN_PASSWORD"));
  assert.ok(!admin.includes("パスワード"));
});

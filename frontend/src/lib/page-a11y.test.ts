import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import AdminPage from "../app/admin/page";
import Home from "../app/page";

test("ログイン画面: 合言葉の欄にラベルが結びつき、環境変数名を出さない", () => {
  const html = renderToStaticMarkup(createElement(AdminPage));
  assert.match(html, /<label[^>]*for="admin-password"[^>]*>合言葉を入れてください。<\/label>/);
  const input = html.match(/<input[^>]*id="admin-password"[^>]*>/)?.[0] ?? "";
  assert.match(input, /type="password"/);
  assert.match(input, /placeholder="合言葉"/);
  assert.match(input, /autoComplete="current-password"|autocomplete="current-password"/);
  assert.ok(!html.includes("ADMIN_PASSWORD"));
});

test("ログイン画面: エラーの表示先が読み上げの対象になっている", () => {
  const html = renderToStaticMarkup(createElement(AdminPage));
  assert.match(html, /role="alert"/);
});

test("ホーム: メッセージの表示先が、メッセージが出る前から aria-live の領域になっている", () => {
  const html = renderToStaticMarkup(createElement(Home));
  assert.match(html, /<div[^>]*role="status"[^>]*aria-live="polite"[^>]*>/);
});

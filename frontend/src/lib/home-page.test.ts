import assert from "node:assert/strict";
import test from "node:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import Home from "../app/page";

// 取得が終わる前の最初の描画（effect は走らない）。初期値を「空の状態」として表示しないことを検証する。

test("ホームは、読み込みが終わるまで「未設定」「今日はまだ静かです。」「未送信 0 / 全0」と表示しない", () => {
  const html = renderToStaticMarkup(createElement(Home));

  assert.ok(!html.includes("未設定"), "購読状態が分かる前に「未設定」と表示している");
  assert.ok(!html.includes("今日はまだ静かです。"), "予定を取得する前に「今日はまだ静かです。」と表示している");
  assert.ok(!html.includes("静かです"), "予定を取得する前に、次のお告げを「静かです」と表示している");
  assert.ok(!/未送信\s*(<!-- -->)?0/.test(html), "予定を取得する前に「未送信 0」と表示している");

  assert.ok(html.includes("確認中"));
  assert.ok(html.includes("予定を読み込んでいます"));
  assert.ok(html.includes("更新中…"));
});

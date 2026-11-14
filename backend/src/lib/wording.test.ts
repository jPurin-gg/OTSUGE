import assert from "node:assert/strict";
import { test } from "node:test";
import { NextRequest } from "next/server";
import { POST as login } from "../app/api/admin/login/route";

// 画面の文言の対応表（issue #26）: ログインは「合言葉」と呼ぶ。
test("合言葉が違うときのエラーは、画面の案内と同じ「合言葉」という言葉を使う", async () => {
  const previous = process.env.ADMIN_PASSWORD;
  process.env.ADMIN_PASSWORD = "correct-horse";
  try {
    const response = await login(
      new NextRequest("http://localhost/api/admin/login", {
        method: "POST",
        body: JSON.stringify({ password: "wrong" }),
      }),
    );
    assert.equal(response.status, 401);
    const body = (await response.json()) as { error: string };
    assert.equal(body.error, "合言葉が違います。");
  } finally {
    if (previous === undefined) delete process.env.ADMIN_PASSWORD;
    else process.env.ADMIN_PASSWORD = previous;
  }
});

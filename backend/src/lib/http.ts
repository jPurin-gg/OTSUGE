import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { ZodError } from "zod";

export function json(data: unknown, init?: ResponseInit) {
  return NextResponse.json(data, init);
}

export function handleError(error: unknown) {
  if (error instanceof ZodError) {
    return json({ error: "入力内容が不正です。", details: error.issues }, { status: 400 });
  }
  const requestId = randomUUID();
  console.error("API request failed", { requestId, error });
  return json(
    { error: `サーバーエラーが発生しました。（参照ID: ${requestId}）`, requestId },
    { status: 500, headers: { "x-request-id": requestId, "cache-control": "no-store" } },
  );
}

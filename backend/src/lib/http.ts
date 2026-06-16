import { NextResponse } from "next/server";
import { ZodError } from "zod";

export function json(data: unknown, init?: ResponseInit) {
  return NextResponse.json(data, init);
}

export function handleError(error: unknown) {
  if (error instanceof ZodError) {
    return json({ error: "入力内容が不正です。", details: error.issues }, { status: 400 });
  }
  console.error(error);
  return json({ error: error instanceof Error ? error.message : "サーバーエラーが発生しました。" }, { status: 500 });
}

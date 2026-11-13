import { NextResponse } from "next/server";
import { ZodError } from "zod";

export function json(data: unknown, init?: ResponseInit) {
  return NextResponse.json(data, init);
}

/** 検証スキーマに書いた利用者向けの文（code が custom の issue）があれば、理由として添える。 */
function validationErrorMessage(error: ZodError) {
  const reasons = error.issues.filter((issue) => issue.code === "custom").map((issue) => issue.message);
  return ["入力内容が不正です。", ...new Set(reasons)].join(" ");
}

export function handleError(error: unknown) {
  if (error instanceof ZodError) {
    return json({ error: validationErrorMessage(error), details: error.issues }, { status: 400 });
  }
  console.error(error);
  return json({ error: error instanceof Error ? error.message : "サーバーエラーが発生しました。" }, { status: 500 });
}

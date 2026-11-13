import { NextRequest } from "next/server";
import { isAdmin, unauthorized } from "@/lib/auth";
import { readyDb } from "@/lib/db";
import { handleError, json } from "@/lib/http";
import { sendSchedule } from "@/lib/push";
import { parseSendInput } from "@/lib/validation";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, context: Context) {
  if (!isAdmin(request)) return unauthorized();
  try {
    const { id } = await context.params;
    const input = parseSendInput(await request.text());
    const database = await readyDb();
    const result = await sendSchedule(database, Number(id), { resend: input.resend });
    if (!result) {
      return json(
        { error: "この通知予定はすでに送信済みか破棄済みのため、送信しませんでした。もう一度送る場合は「再送」を押してください。" },
        { status: 409 },
      );
    }
    return json(result);
  } catch (error) {
    return handleError(error);
  }
}

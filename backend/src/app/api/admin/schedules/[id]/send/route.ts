import { NextRequest } from "next/server";
import { isAdmin, unauthorized } from "@/lib/auth";
import { readyDb } from "@/lib/db";
import { handleError, json } from "@/lib/http";
import { sendSchedule } from "@/lib/push";

type Context = { params: Promise<{ id: string }> };

export async function POST(request: NextRequest, context: Context) {
  if (!isAdmin(request)) return unauthorized();
  try {
    const { id } = await context.params;
    const database = await readyDb();
    const result = await sendSchedule(database, Number(id));
    if (!result) return json({ error: "この通知予定は送信済みか、現在処理中です。" }, { status: 409 });
    return json(result);
  } catch (error) {
    return handleError(error);
  }
}

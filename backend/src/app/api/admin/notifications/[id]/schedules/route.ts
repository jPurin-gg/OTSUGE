import { NextRequest } from "next/server";
import { isAdmin, unauthorized } from "@/lib/auth";
import { readyDb } from "@/lib/db";
import { handleError, json } from "@/lib/http";
import { regenerateNotificationSchedules } from "@/lib/scheduler";

type Context = { params: Promise<{ id: string }> };

// このお告げだけ、当日の予定を現在の設定で引き直す（ほかのお告げの予定には触れない）。
export async function POST(request: NextRequest, context: Context) {
  if (!isAdmin(request)) return unauthorized();
  try {
    const { id } = await context.params;
    const database = await readyDb();
    const result = /^\d+$/.test(id) ? await regenerateNotificationSchedules(database, Number(id)) : null;
    if (!result) return json({ error: "お告げが見つかりません。" }, { status: 404 });
    return json(result);
  } catch (error) {
    return handleError(error);
  }
}

import { NextRequest } from "next/server";
import { isAdmin, unauthorized } from "@/lib/auth";
import { readyDb } from "@/lib/db";
import { handleError, json } from "@/lib/http";
import { updateScheduleTime } from "@/lib/schedule-update";
import { scheduleInput } from "@/lib/validation";

type Context = { params: Promise<{ id: string }> };

export async function PUT(request: NextRequest, context: Context) {
  if (!isAdmin(request)) return unauthorized();
  try {
    const { id } = await context.params;
    const input = scheduleInput.parse(await request.json());
    const database = await readyDb();
    const result = await updateScheduleTime(database, Number(id), input.scheduled_at);
    if (result === "not_found") return json({ error: "通知予定が見つかりません。" }, { status: 404 });
    if (result === "locked") {
      return json({ error: "送信済み・破棄済みの通知予定は時刻を変更できません。" }, { status: 409 });
    }
    if (result === "other_day") {
      return json({ error: "配信時刻は予定と同じ日の中で指定してください。" }, { status: 400 });
    }
    return json({ ok: true, changed: result === "updated" });
  } catch (error) {
    return handleError(error);
  }
}

export async function DELETE(request: NextRequest, context: Context) {
  if (!isAdmin(request)) return unauthorized();
  const { id } = await context.params;
  const database = await readyDb();
  await database("schedules").where({ id: Number(id) }).delete();
  return json({ ok: true });
}

import { NextRequest } from "next/server";
import { isAdmin, unauthorized } from "@/lib/auth";
import { readyDb } from "@/lib/db";
import { handleError, json } from "@/lib/http";
import { scheduleInput } from "@/lib/validation";

type Context = { params: Promise<{ id: string }> };

export async function PUT(request: NextRequest, context: Context) {
  if (!isAdmin(request)) return unauthorized();
  try {
    const { id } = await context.params;
    const input = scheduleInput.parse(await request.json());
    const database = await readyDb();
    await database("schedules").where({ id: Number(id) }).update({
      scheduled_at: input.scheduled_at,
      manually_modified: true,
      updated_at: new Date().toISOString(),
    });
    return json({ ok: true });
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

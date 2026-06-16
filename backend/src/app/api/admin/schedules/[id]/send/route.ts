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
    return json(await sendSchedule(database, Number(id)));
  } catch (error) {
    return handleError(error);
  }
}

import { NextRequest } from "next/server";
import { isAdmin, unauthorized } from "@/lib/auth";
import { readyDb } from "@/lib/db";
import { handleError, json } from "@/lib/http";
import { quietHoursInput } from "@/lib/validation";

export async function GET(request: NextRequest) {
  if (!isAdmin(request)) return unauthorized();
  const database = await readyDb();
  const rows = await database("quiet_hours").select("*").orderBy("id", "asc");
  return json({ quietHours: rows });
}

export async function POST(request: NextRequest) {
  if (!isAdmin(request)) return unauthorized();
  try {
    const input = quietHoursInput.parse(await request.json());
    const database = await readyDb();
    const now = new Date().toISOString();
    const inserted = await database("quiet_hours").insert({
      ...input,
      created_at: now,
      updated_at: now,
    }).returning("id");
    const id = typeof inserted[0] === "object" ? inserted[0].id : inserted[0];
    return json({ id }, { status: 201 });
  } catch (error) {
    return handleError(error);
  }
}

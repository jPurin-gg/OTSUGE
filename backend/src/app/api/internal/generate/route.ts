import { NextRequest } from "next/server";
import { checkInternal } from "@/lib/auth";
import { readyDb } from "@/lib/db";
import { json } from "@/lib/http";
import { generateDailySchedules } from "@/lib/scheduler";

export async function POST(request: NextRequest) {
  if (!checkInternal(request)) return json({ error: "forbidden" }, { status: 403 });
  const database = await readyDb();
  return json(await generateDailySchedules(database));
}

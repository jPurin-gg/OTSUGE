import { NextRequest } from "next/server";
import { checkInternal } from "@/lib/auth";
import { readyDb } from "@/lib/db";
import { handleError, json } from "@/lib/http";
import { dispatchDueSchedules } from "@/lib/push";

export async function POST(request: NextRequest) {
  if (!checkInternal(request)) return json({ error: "forbidden" }, { status: 403 });
  try {
    const database = await readyDb();
    return json(await dispatchDueSchedules(database));
  } catch (error) {
    return handleError(error);
  }
}

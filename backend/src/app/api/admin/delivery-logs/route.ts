import { NextRequest } from "next/server";
import { isAdmin, unauthorized } from "@/lib/auth";
import { readyDb } from "@/lib/db";
import { handleError, json } from "@/lib/http";

export async function GET(request: NextRequest) {
  if (!isAdmin(request)) return unauthorized();
  try {
    const database = await readyDb();
    const rows = await database("delivery_logs").select("*").orderBy("sent_at", "desc").limit(50);
    return json({ deliveryLogs: rows });
  } catch (error) {
    return handleError(error);
  }
}

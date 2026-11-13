import { NextRequest } from "next/server";
import { isAdmin, unauthorized } from "@/lib/auth";
import { readyDb } from "@/lib/db";
import { handleError, json } from "@/lib/http";

export async function GET(request: NextRequest) {
  if (!isAdmin(request)) return unauthorized();
  try {
    const database = await readyDb();
    const subscriptions = await database("subscriptions").count<{ count: string | number }>({ count: "*" }).first();
    return json({ subscriptionCount: Number(subscriptions?.count ?? 0) });
  } catch (error) {
    return handleError(error);
  }
}

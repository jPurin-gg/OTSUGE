import { NextRequest, NextResponse } from "next/server";
import { clearAdminCookie } from "@/lib/auth";

export async function POST(request: NextRequest) {
  const response = NextResponse.json({ ok: true });
  await clearAdminCookie(request, response);
  return response;
}

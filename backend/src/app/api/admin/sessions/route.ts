import { NextRequest, NextResponse } from "next/server";
import { clearAdminCookie, isAdmin, revokeAllAdminSessions, unauthorized } from "@/lib/auth";

export async function DELETE(request: NextRequest) {
  if (!(await isAdmin(request))) return unauthorized();
  await revokeAllAdminSessions();
  const response = NextResponse.json({ ok: true });
  await clearAdminCookie(request, response);
  return response;
}

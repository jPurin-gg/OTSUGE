import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { getAdminAuthConfig, setAdminCookie } from "@/lib/auth";
import { handleError } from "@/lib/http";

export async function POST(request: NextRequest) {
  try {
    const { password } = getAdminAuthConfig();
    const input = z.object({ password: z.string() }).parse(await request.json());
    if (input.password !== password) {
      return NextResponse.json({ error: "パスワードが違います。" }, { status: 401 });
    }
    const response = NextResponse.json({ ok: true });
    setAdminCookie(response);
    return response;
  } catch (error) {
    return handleError(error);
  }
}

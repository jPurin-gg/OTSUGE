import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { setAdminCookie } from "@/lib/auth";
import { handleError } from "@/lib/http";

export async function POST(request: NextRequest) {
  try {
    const input = z.object({ password: z.string() }).parse(await request.json());
    if (!process.env.ADMIN_PASSWORD || input.password !== process.env.ADMIN_PASSWORD) {
      return NextResponse.json({ error: "パスワードが違います。" }, { status: 401 });
    }
    const response = NextResponse.json({ ok: true });
    setAdminCookie(response);
    return response;
  } catch (error) {
    return handleError(error);
  }
}

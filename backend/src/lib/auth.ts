import { createHash, timingSafeEqual } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";

const COOKIE_NAME = "otsuge_admin";

function token() {
  return createHash("sha256")
    .update(`${process.env.ADMIN_PASSWORD ?? ""}:${process.env.AUTH_SECRET ?? ""}`)
    .digest("hex");
}

export function isAdmin(request: NextRequest) {
  const actual = request.cookies.get(COOKIE_NAME)?.value ?? "";
  const expected = token();
  if (actual.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(actual), Buffer.from(expected));
}

export function unauthorized() {
  return NextResponse.json({ error: "認証が必要です。" }, { status: 401 });
}

export function setAdminCookie(response: NextResponse) {
  response.cookies.set(COOKIE_NAME, token(), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    maxAge: 60 * 60 * 24 * 7,
    path: "/",
  });
}

export function clearAdminCookie(response: NextResponse) {
  response.cookies.set(COOKIE_NAME, "", { httpOnly: true, maxAge: 0, path: "/" });
}

export function checkInternal(request: NextRequest) {
  const expected = process.env.CRON_SECRET ?? "";
  return Boolean(expected) && request.headers.get("authorization") === `Bearer ${expected}`;
}

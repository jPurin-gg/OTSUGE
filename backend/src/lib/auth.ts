import { createHmac, randomBytes } from "node:crypto";
import { NextRequest, NextResponse } from "next/server";
import { readyDb } from "./db";

const COOKIE_NAME = "otsuge_admin";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 7;

function sessionHash(sessionId: string) {
  return createHmac("sha256", `${process.env.ADMIN_PASSWORD ?? ""}:${process.env.AUTH_SECRET ?? ""}`)
    .update(sessionId)
    .digest("hex");
}

function sessionIdFrom(request: NextRequest) {
  const value = request.cookies.get(COOKIE_NAME)?.value ?? "";
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
}

export async function isAdmin(request: NextRequest) {
  const sessionId = sessionIdFrom(request);
  if (!sessionId) return false;
  const database = await readyDb();
  const session = await database("admin_sessions")
    .where({ id_hash: sessionHash(sessionId) })
    .whereNull("revoked_at")
    .andWhere("expires_at", ">", new Date().toISOString())
    .first("id_hash");
  return Boolean(session);
}

export function unauthorized() {
  return NextResponse.json({ error: "認証が必要です。" }, { status: 401 });
}

export async function setAdminCookie(response: NextResponse) {
  const database = await readyDb();
  const sessionId = randomBytes(32).toString("base64url");
  const now = new Date();
  await database("admin_sessions").where("expires_at", "<=", now.toISOString()).delete();
  await database("admin_sessions").insert({
    id_hash: sessionHash(sessionId),
    created_at: now.toISOString(),
    expires_at: new Date(now.getTime() + SESSION_MAX_AGE_SECONDS * 1000).toISOString(),
    revoked_at: null,
  });
  response.cookies.set(COOKIE_NAME, sessionId, {
    httpOnly: true,
    sameSite: "lax",
    secure: (process.env.FRONTEND_ORIGIN ?? "").startsWith("https://"),
    maxAge: SESSION_MAX_AGE_SECONDS,
    path: "/",
  });
}

export async function clearAdminCookie(request: NextRequest, response: NextResponse) {
  const sessionId = sessionIdFrom(request);
  if (sessionId) {
    const database = await readyDb();
    await database("admin_sessions")
      .where({ id_hash: sessionHash(sessionId) })
      .whereNull("revoked_at")
      .update({ revoked_at: new Date().toISOString() });
  }
  response.cookies.set(COOKIE_NAME, "", { httpOnly: true, maxAge: 0, path: "/" });
}

export async function revokeAllAdminSessions() {
  const database = await readyDb();
  await database("admin_sessions")
    .whereNull("revoked_at")
    .update({ revoked_at: new Date().toISOString() });
}

export function checkInternal(request: NextRequest) {
  const expected = process.env.CRON_SECRET ?? "";
  return Boolean(expected) && request.headers.get("authorization") === `Bearer ${expected}`;
}

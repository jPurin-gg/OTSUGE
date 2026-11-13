import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { after, before, beforeEach, test } from "node:test";
import { NextRequest } from "next/server";

const COOKIE_NAME = "otsuge_admin";
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;
const environmentKeys = ["DB_CLIENT", "SQLITE_PATH", "ADMIN_PASSWORD", "AUTH_SECRET", "FRONTEND_ORIGIN"] as const;
const originalEnvironment = Object.fromEntries(environmentKeys.map((key) => [key, process.env[key]]));
let directory: string;
let database: Awaited<ReturnType<typeof import("./db").readyDb>>;
let auth: typeof import("./auth");
let login: typeof import("../app/api/admin/login/route").POST;
let logout: typeof import("../app/api/admin/logout/route").POST;

function request(path: string, sessionId?: string, method = "GET", body?: unknown) {
  return new NextRequest(`http://localhost:3001/api/admin/${path}`, {
    method,
    headers: sessionId ? { cookie: `${COOKIE_NAME}=${sessionId}` } : undefined,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function signIn() {
  const response = await login(request("login", undefined, "POST", { password: process.env.ADMIN_PASSWORD }));
  assert.equal(response.status, 200);
  const cookie = response.cookies.get(COOKIE_NAME);
  assert.ok(cookie?.value);
  return { response, cookie, sessionId: cookie.value };
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), "otsuge-9-sessions-"));
  process.env.DB_CLIENT = "sqlite";
  process.env.SQLITE_PATH = join(directory, "sessions.sqlite3");
  process.env.ADMIN_PASSWORD = "synthetic-admin-password";
  process.env.AUTH_SECRET = "synthetic-auth-secret";
  process.env.FRONTEND_ORIGIN = "https://admin.example.test";
  auth = await import("./auth");
  ({ POST: login } = await import("../app/api/admin/login/route"));
  ({ POST: logout } = await import("../app/api/admin/logout/route"));
  database = await (await import("./db")).readyDb();
});

beforeEach(async () => {
  if (await database.schema.hasTable("admin_sessions")) await database("admin_sessions").delete();
});

after(async () => {
  await database?.destroy();
  if (directory) await rm(directory, { recursive: true, force: true });
  for (const key of environmentKeys) {
    const value = originalEnvironment[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

test("each login issues a distinct session with a matching seven-day server expiry", async (context) => {
  const now = Date.parse("2026-01-01T00:00:00.000Z");
  context.mock.timers.enable({ apis: ["Date"], now });
  const first = await signIn();
  const second = await signIn();
  assert.notEqual(first.sessionId, second.sessionId);
  assert.match(first.sessionId, /^[A-Za-z0-9_-]{43}$/);
  assert.equal(first.cookie.maxAge, SEVEN_DAYS_MS / 1000);
  assert.equal(first.cookie.httpOnly, true);
  assert.equal(first.cookie.sameSite, "lax");
  assert.equal(first.cookie.secure, true);
  assert.equal(first.cookie.path, "/");
  const sessions = await database("admin_sessions").select("*");
  assert.equal(sessions.length, 2);
  for (const session of sessions) {
    assert.notEqual(session.id_hash, first.sessionId);
    assert.notEqual(session.id_hash, second.sessionId);
    assert.equal(new Date(session.created_at).getTime(), now);
    assert.equal(new Date(session.expires_at).getTime(), now + SEVEN_DAYS_MS);
    assert.equal(session.revoked_at, null);
  }
  assert.equal(await auth.isAdmin(request("stats", first.sessionId)), true);
  assert.equal(await auth.isAdmin(request("stats", second.sessionId)), true);
});

test("missing, malformed, and unknown cookies return 401", async () => {
  const { GET } = await import("../app/api/admin/stats/route");
  for (const value of [undefined, "bad-cookie", "a".repeat(43), encodeURIComponent("あ".repeat(64))]) {
    assert.equal((await GET(request("stats", value))).status, 401);
  }
});

test("legacy deterministic cookies return 401 even after a new login", async () => {
  await signIn();
  const { GET } = await import("../app/api/admin/stats/route");
  const legacy = createHash("sha256")
    .update(`${process.env.ADMIN_PASSWORD}:${process.env.AUTH_SECRET}`)
    .digest("hex");
  assert.equal((await GET(request("stats", legacy))).status, 401);
});

test("copied cookies are rejected at seven days and later without extending expiry", async (context) => {
  const now = Date.parse("2026-01-01T00:00:00.000Z");
  context.mock.timers.enable({ apis: ["Date"], now });
  const { sessionId } = await signIn();
  const { GET } = await import("../app/api/admin/stats/route");
  context.mock.timers.setTime(now + SEVEN_DAYS_MS - 1);
  assert.equal((await GET(request("stats", sessionId))).status, 200);
  context.mock.timers.setTime(now + SEVEN_DAYS_MS);
  assert.equal((await GET(request("stats", sessionId))).status, 401);
  context.mock.timers.setTime(now + SEVEN_DAYS_MS + 1);
  assert.equal((await GET(request("stats", sessionId))).status, 401);
});

test("logout revokes a copied cookie while another login stays valid", async () => {
  const first = await signIn();
  const second = await signIn();
  const response = await logout(request("logout", first.sessionId, "POST"));
  assert.equal(response.status, 200);
  assert.equal(response.cookies.get(COOKIE_NAME)?.maxAge, 0);
  const { GET } = await import("../app/api/admin/stats/route");
  assert.equal((await GET(request("stats", first.sessionId))).status, 401);
  assert.equal((await GET(request("stats", second.sessionId))).status, 200);
  assert.equal((await database("admin_sessions").whereNotNull("revoked_at")).length, 1);
  assert.equal((await logout(request("logout", first.sessionId, "POST"))).status, 200);
});

test("logout without a cookie succeeds without revoking another session", async () => {
  const { sessionId } = await signIn();
  for (const value of [undefined, "malformed", "a".repeat(43)]) {
    assert.equal((await logout(request("logout", value, "POST"))).status, 200);
  }
  assert.equal(await auth.isAdmin(request("stats", sessionId)), true);
});

test("all-session revocation requires authentication and permits a fresh login", async () => {
  const { DELETE } = await import("../app/api/admin/sessions/route");
  const first = await signIn();
  const second = await signIn();
  assert.equal((await DELETE(request("sessions", undefined, "DELETE"))).status, 401);
  assert.equal(await auth.isAdmin(request("stats", first.sessionId)), true);
  const response = await DELETE(request("sessions", first.sessionId, "DELETE"));
  assert.equal(response.status, 200);
  assert.equal(response.cookies.get(COOKIE_NAME)?.maxAge, 0);
  for (const value of [first.sessionId, second.sessionId]) {
    assert.equal(await auth.isAdmin(request("stats", value)), false);
  }
  assert.equal((await DELETE(request("sessions", second.sessionId, "DELETE"))).status, 401);
  const fresh = await signIn();
  assert.equal(await auth.isAdmin(request("stats", fresh.sessionId)), true);
});

test("changing either authentication secret invalidates existing sessions", async () => {
  const { sessionId } = await signIn();
  for (const key of ["ADMIN_PASSWORD", "AUTH_SECRET"] as const) {
    const original = process.env[key];
    try {
      process.env[key] = "rotated-synthetic-value";
      assert.equal(await auth.isAdmin(request("stats", sessionId)), false);
    } finally {
      process.env[key] = original;
    }
  }
});

test("invalid login does not create a session or cookie", async () => {
  const response = await login(request("login", undefined, "POST", { password: "incorrect" }));
  assert.equal(response.status, 401);
  assert.equal(response.cookies.get(COOKIE_NAME), undefined);
  assert.equal((await database("admin_sessions")).length, 0);
});

test("session validation and revocation are shared with a separate server process", async () => {
  const { sessionId } = await signIn();
  const script = `
    const { NextRequest, NextResponse } = require("next/server");
    const { isAdmin, clearAdminCookie } = require("./src/lib/auth.ts");
    const { db } = require("./src/lib/db.ts");
    (async () => {
      try {
        const request = new NextRequest("http://localhost:3001/api/admin/stats", {
          headers: { cookie: "otsuge_admin=" + process.env.OTSUGE_TEST_SESSION },
        });
        console.log(await isAdmin(request));
        await clearAdminCookie(request, NextResponse.json({ ok: true }));
      } finally {
        await db.destroy();
      }
    })().catch(() => { process.exitCode = 1; });
  `;
  const { stdout } = await promisify(execFile)(process.execPath, ["--import", "tsx", "--eval", script], {
    env: { ...process.env, OTSUGE_TEST_SESSION: sessionId },
  });
  assert.equal(stdout.trim(), "true");
  assert.equal(await auth.isAdmin(request("stats", sessionId)), false);
});

test("initialization adds session storage to an existing application database", async () => {
  assert.equal(await database.schema.hasTable("notifications"), true);
  await database.schema.dropTableIfExists("admin_sessions");
  global.otsugeDbReady = undefined;
  await (await import("./db")).readyDb();
  assert.equal(await database.schema.hasTable("admin_sessions"), true);
  assert.equal(await database.schema.hasColumn("admin_sessions", "expires_at"), true);
  assert.equal(await database.schema.hasColumn("admin_sessions", "revoked_at"), true);
});

test("new logins remove expired session records", async (context) => {
  const now = Date.parse("2026-01-01T00:00:00.000Z");
  context.mock.timers.enable({ apis: ["Date"], now });
  const first = await signIn();
  context.mock.timers.setTime(now + SEVEN_DAYS_MS);
  const second = await signIn();
  assert.equal((await database("admin_sessions")).length, 1);
  assert.equal(await auth.isAdmin(request("stats", first.sessionId)), false);
  assert.equal(await auth.isAdmin(request("stats", second.sessionId)), true);
});

test("every protected admin handler rejects expired and revoked cookies", async () => {
  const routes = [
    ["notifications/route", ["GET", "POST"]],
    ["notifications/[id]/route", ["PUT", "DELETE"]],
    ["quiet-hours/route", ["GET", "POST"]],
    ["quiet-hours/[id]/route", ["PUT", "DELETE"]],
    ["schedules/route", ["GET", "POST"]],
    ["schedules/[id]/route", ["PUT", "DELETE"]],
    ["schedules/[id]/send/route", ["POST"]],
    ["delivery-logs/route", ["GET"]],
    ["stats/route", ["GET"]],
    ["sessions/route", ["DELETE"]],
  ] as const;
  for (const state of ["expired", "revoked"]) {
    const { sessionId } = await signIn();
    await database("admin_sessions").update(state === "expired"
      ? { expires_at: new Date(0).toISOString() }
      : { revoked_at: new Date().toISOString() });
    for (const [path, methods] of routes) {
      const handlers = await import(`../app/api/admin/${path}`);
      for (const method of methods) {
        const response = await handlers[method](request(path, sessionId, method), {
          params: Promise.resolve({ id: "1" }),
        });
        assert.equal(response.status, 401, `${state}: ${method} ${path}`);
      }
    }
  }
});

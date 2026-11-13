import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import type { Knex } from "knex";
import { PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_BUILD, PHASE_PRODUCTION_SERVER } from "next/constants";
import { NextRequest, NextResponse } from "next/server";
import nextConfig from "../../next.config";
import * as auth from "./auth";

const password = "test-admin-password";
const secret = "test-auth-secret";
const cookieName = "otsuge_admin";
const notification = {
  message: "テスト通知",
  start_time: "09:00",
  end_time: "21:00",
  count_per_day: 1,
  min_interval_minutes: 60,
  enabled: true,
};

let login: typeof import("../app/api/admin/login/route");
let notifications: typeof import("../app/api/admin/notifications/route");
let databaseCalls = 0;
const rows: Record<string, unknown>[] = [];
const originalDb = global.otsugeDb;
const originalDbReady = global.otsugeDbReady;

test.before(async () => {
  // Install a completely in-memory fake before importing routes, so neither
  // database creation nor schema initialization can reach a real database.
  global.otsugeDb = ((table: string) => {
    databaseCalls += 1;
    assert.equal(table, "notifications");
    return {
      select: () => ({ orderBy: async () => rows }),
      insert: (row: Record<string, unknown>) => ({
        returning: async () => {
          const id = rows.length + 1;
          rows.push({ id, ...row });
          return [{ id }];
        },
      }),
    };
  }) as unknown as Knex;
  global.otsugeDbReady = Promise.resolve();
  login = await import("../app/api/admin/login/route");
  notifications = await import("../app/api/admin/notifications/route");
});

test.after(() => {
  global.otsugeDb = originalDb;
  global.otsugeDbReady = originalDbReady;
});

async function withEnvironment(
  values: Record<string, string | undefined>,
  run: () => void | Promise<void>,
) {
  const previous = Object.fromEntries(Object.keys(values).map((key) => [key, process.env[key]]));
  try {
    for (const [key, value] of Object.entries(values)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await run();
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

function request(path: string, cookie?: string, body?: unknown) {
  return new NextRequest(`http://localhost:3001/api/admin/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(cookie === undefined ? {} : { cookie: `${cookieName}=${cookie}` }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

const states = [
  { name: "unset", value: undefined },
  { name: "empty", value: "" },
  { name: "configured", value: "configured" },
];

for (const passwordState of states) {
  for (const secretState of states) {
    if (passwordState.name === "configured" && secretState.name === "configured") continue;
    test(`invalid configuration rejects authentication: password ${passwordState.name}, secret ${secretState.name}`, async (t) => {
      const adminPassword = passwordState.value ? password : passwordState.value;
      const authSecret = secretState.value ? secret : secretState.value;
      const logs: unknown[][] = [];
      t.mock.method(console, "error", (...args: unknown[]) => logs.push(args));
      await withEnvironment(
        { ADMIN_PASSWORD: adminPassword, AUTH_SECRET: authSecret, NEXT_RUNTIME: "nodejs" },
        async () => {
          const knownHash = createHash("sha256")
            .update(`${adminPassword ?? ""}:${authSecret ?? ""}`)
            .digest("hex");
          assert.equal(auth.isAdmin(request("notifications", knownHash)), false);

          const before = databaseCalls;
          assert.equal((await notifications.GET(request("notifications", knownHash))).status, 401);
          assert.equal(
            (await notifications.POST(request("notifications", knownHash, notification))).status,
            401,
          );
          assert.equal(databaseCalls, before, "invalid configuration must not reach the database");

          const checkDiagnostic = (error: unknown) => {
            assert.ok(error instanceof Error);
            if (!adminPassword) assert.match(error.message, /ADMIN_PASSWORD/);
            if (!authSecret) assert.match(error.message, /AUTH_SECRET/);
            assert.ok(!error.message.includes(password));
            assert.ok(!error.message.includes(secret));
            return true;
          };
          assert.throws(() => auth.getAdminAuthConfig(), checkDiagnostic);
          const response = NextResponse.json({ ok: true });
          assert.throws(() => auth.setAdminCookie(response), checkDiagnostic);
          assert.equal(response.headers.has("set-cookie"), false);

          const loginResponse = await login.POST(request("login", undefined, { password: adminPassword ?? "" }));
          assert.equal(loginResponse.status, 500);
          assert.equal(loginResponse.headers.has("set-cookie"), false);
          const loginError = await loginResponse.json();
          checkDiagnostic(new Error(loginError.error));
          for (const entry of logs.flat()) {
            assert.ok(!String(entry).includes(password));
            assert.ok(!String(entry).includes(secret));
          }

          for (const phase of [PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_SERVER]) {
            assert.throws(() => nextConfig(phase), checkDiagnostic);
          }
          const { register } = await import("../instrumentation");
          await assert.rejects(async () => register(), checkDiagnostic);
        },
      );
    });
  }
}

test("valid configuration supports startup, login, cookie verification, and notification operations", async () => {
  await withEnvironment(
    {
      ADMIN_PASSWORD: password,
      AUTH_SECRET: secret,
      FRONTEND_ORIGIN: "https://example.test",
      NEXT_RUNTIME: "nodejs",
    },
    async () => {
      for (const phase of [PHASE_DEVELOPMENT_SERVER, PHASE_PRODUCTION_SERVER]) {
        assert.doesNotThrow(() => nextConfig(phase));
      }
      const { register } = await import("../instrumentation");
      await assert.doesNotReject(async () => register());
      assert.deepEqual(auth.getAdminAuthConfig(), { password, secret });

      const loginResponse = await login.POST(request("login", undefined, { password }));
      assert.equal(loginResponse.status, 200);
      assert.deepEqual(await loginResponse.json(), { ok: true });
      const cookie = loginResponse.cookies.get(cookieName);
      assert.ok(cookie);
      assert.equal(cookie.httpOnly, true);
      assert.equal(cookie.secure, true);
      assert.equal(cookie.sameSite, "lax");
      assert.equal(cookie.path, "/");
      assert.equal(auth.isAdmin(request("notifications", cookie.value)), true);

      const created = await notifications.POST(request("notifications", cookie.value, notification));
      assert.equal(created.status, 201);
      assert.deepEqual(await created.json(), { id: 1 });
      const listed = await notifications.GET(request("notifications", cookie.value));
      assert.equal(listed.status, 200);
      const result = await listed.json();
      assert.equal(result.notifications.length, 1);
      assert.equal(result.notifications[0].message, notification.message);
    },
  );
});

test("build configuration does not require runtime authentication secrets", async () => {
  await withEnvironment({ ADMIN_PASSWORD: undefined, AUTH_SECRET: undefined }, () => {
    assert.equal(nextConfig(PHASE_PRODUCTION_BUILD).output, "standalone");
  });
});

test("valid configuration still rejects incorrect passwords and missing or forged cookies", async () => {
  await withEnvironment({ ADMIN_PASSWORD: password, AUTH_SECRET: secret }, async () => {
    const response = await login.POST(request("login", undefined, { password: "wrong-password" }));
    assert.equal(response.status, 401);
    assert.equal(response.headers.has("set-cookie"), false);
    const before = databaseCalls;
    for (const cookie of [undefined, "wrong-cookie", "0".repeat(64)]) {
      assert.equal(auth.isAdmin(request("notifications", cookie)), false);
      assert.equal((await notifications.GET(request("notifications", cookie))).status, 401);
    }
    assert.equal(databaseCalls, before);
  });
});

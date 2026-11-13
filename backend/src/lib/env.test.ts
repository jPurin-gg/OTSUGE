import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { parseEnv } from "node:util";
import { NextRequest } from "next/server";
import { proxy } from "../proxy";
import { checkInternal } from "./auth";
import { getDatabaseConfig } from "./db-config";
import { dayBounds, localDateKey, localMinuteOfDay } from "./time";

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

for (const value of [undefined, ""]) {
  const name = value === undefined ? "unset" : "empty";

  test(`timezone defaults to Asia/Tokyo when ${name}`, async () => {
    await withEnvironment({ APP_TIMEZONE: value }, () => {
      const date = new Date("2026-11-13T15:30:00Z");
      assert.equal(localDateKey(date), "2026-11-14");
      assert.equal(localMinuteOfDay(date), 30);
      const bounds = dayBounds("2026-11-14");
      assert.equal(bounds.start.toISOString(), "2026-11-13T15:00:00.000Z");
      assert.equal(bounds.end.toISOString(), "2026-11-14T15:00:00.000Z");
    });
  });

  test(`CORS defaults to localhost when FRONTEND_ORIGIN is ${name}`, async () => {
    await withEnvironment({ FRONTEND_ORIGIN: value }, () => {
      const response = proxy(new NextRequest("http://localhost:3001/api/public/schedules", {
        method: "OPTIONS",
        headers: { origin: "http://localhost:3000" },
      }));
      assert.equal(response.status, 204);
      assert.equal(response.headers.get("access-control-allow-origin"), "http://localhost:3000");
    });
  });

  test(`internal authentication reports CRON_SECRET when ${name}`, async () => {
    await withEnvironment({ CRON_SECRET: value }, () => {
      assert.throws(
        () => checkInternal(new NextRequest("http://localhost:3001/api/internal/generate")),
        /必須環境変数が未設定または空です: CRON_SECRET/,
      );
    });
  });

  test(`SQLite rejects SQLITE_PATH when ${name} without using another database`, async () => {
    await withEnvironment({ DB_CLIENT: "sqlite", SQLITE_PATH: value, DATABASE_URL: "postgres://unused" }, async () => {
      assert.throws(getDatabaseConfig, /^Error: データベースの必須環境変数が未設定または空です: SQLITE_PATH$/);
      const { readyDb } = await import("./db");
      await assert.rejects(readyDb(), /必須環境変数が未設定または空です: SQLITE_PATH/);
      assert.equal(global.otsugeDb, undefined);
    });
  });

  test(`Postgres rejects DATABASE_URL when ${name} without falling back to SQLite`, async () => {
    await withEnvironment({ DB_CLIENT: "postgres", DATABASE_URL: value, SQLITE_PATH: "/unused.sqlite3" }, async () => {
      assert.throws(getDatabaseConfig, /^Error: データベースの必須環境変数が未設定または空です: DATABASE_URL$/);
      const { readyDb } = await import("./db");
      await assert.rejects(readyDb(), /必須環境変数が未設定または空です: DATABASE_URL/);
      assert.equal(global.otsugeDb, undefined);
    });
  });

  test(`DB_CLIENT defaults to SQLite when ${name}`, async () => {
    await withEnvironment({ DB_CLIENT: value, SQLITE_PATH: "/data/test.sqlite3" }, () => {
      assert.deepEqual(getDatabaseConfig(), {
        client: "sqlite3", connection: { filename: "/data/test.sqlite3" }, useNullAsDefault: true,
      });
    });
  });
}

test("Postgres uses the configured connection without requiring SQLITE_PATH", async () => {
  const connection = "postgres://test-user:test-only-password@invalid.example/test-db";
  await withEnvironment({ DB_CLIENT: "postgres", DATABASE_URL: connection, SQLITE_PATH: "" }, () => {
    assert.deepEqual(getDatabaseConfig(), { client: "pg", connection, pool: { min: 1, max: 10 } });
  });
});

test("unsupported DB_CLIENT reports the variable name without exposing its value", async () => {
  await withEnvironment({ DB_CLIENT: "invalid-test-only-value", SQLITE_PATH: "/data/test.sqlite3" }, () => {
    assert.throws(getDatabaseConfig, { message: "DB_CLIENT は sqlite または postgres を指定してください。" });
  });
});

test("local backend and database examples provide working non-secret defaults", async () => {
  const backend = parseEnv(readFileSync(new URL("../../backend.env.example", import.meta.url), "utf8"));
  const database = parseEnv(readFileSync(new URL("../../../database/database.env.example", import.meta.url), "utf8"));
  await withEnvironment({ ...backend, ...database }, () => {
    assert.equal(backend.APP_TIMEZONE, "Asia/Tokyo");
    assert.equal(backend.FRONTEND_ORIGIN, "http://localhost:3000");
    assert.deepEqual(getDatabaseConfig(), {
      client: "sqlite3", connection: { filename: "/data/otsuge.sqlite3" }, useNullAsDefault: true,
    });
  });
});

test("importing database routes does not require runtime database configuration", async () => {
  await withEnvironment({ DB_CLIENT: undefined, SQLITE_PATH: undefined, DATABASE_URL: undefined }, async () => {
    const { GET } = await import("../app/api/health/route");
    assert.equal(global.otsugeDb, undefined);
    await assert.rejects(GET(), /必須環境変数が未設定または空です: SQLITE_PATH/);
  });
});

test("internal authentication still rejects missing or incorrect bearer tokens", async () => {
  await withEnvironment({ CRON_SECRET: "test-only-cron-secret" }, () => {
    const url = "http://localhost:3001/api/internal/generate";
    assert.equal(checkInternal(new NextRequest(url)), false);
    assert.equal(checkInternal(new NextRequest(url, { headers: { authorization: "Bearer wrong" } })), false);
    assert.equal(checkInternal(new NextRequest(url, {
      headers: { authorization: "Bearer test-only-cron-secret" },
    })), true);
  });
});

test("explicit timezone and CORS origins are preserved", async () => {
  await withEnvironment({ APP_TIMEZONE: "UTC", FRONTEND_ORIGIN: "https://one.example, https://two.example" }, () => {
    const date = new Date("2026-11-13T15:30:00Z");
    assert.equal(localDateKey(date), "2026-11-13");
    assert.equal(localMinuteOfDay(date), 15 * 60 + 30);
    const response = proxy(new NextRequest("http://localhost:3001/api/public/schedules", {
      headers: { origin: "https://two.example" },
    }));
    assert.equal(response.headers.get("access-control-allow-origin"), "https://two.example");
  });
});

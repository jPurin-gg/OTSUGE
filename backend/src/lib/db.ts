import knex, { Knex } from "knex";
import { initializeSchema } from "./db-schema";

declare global {
  var otsugeDb: Knex | undefined;
  var otsugeDbReady: Promise<void> | undefined;
}

function createDb() {
  if ((process.env.DB_CLIENT ?? "sqlite") === "postgres") {
    return knex({
      client: "pg",
      connection: process.env.DATABASE_URL,
      pool: { min: 1, max: 10 },
    });
  }

  return knex({
    client: "sqlite3",
    connection: {
      filename: process.env.SQLITE_PATH ?? "/data/otsuge.sqlite3",
    },
    useNullAsDefault: true,
  });
}

export const db = global.otsugeDb ?? createDb();
if (process.env.NODE_ENV !== "production") global.otsugeDb = db;

export async function readyDb() {
  global.otsugeDbReady ??= initializeSchema(db);
  await global.otsugeDbReady;
  return db;
}

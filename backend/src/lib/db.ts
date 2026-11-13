import knex, { Knex } from "knex";
import type { Database as SqliteDatabase } from "sqlite3";

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
    pool: {
      afterCreate(connection: SqliteDatabase, done: (error: Error | null, connection: SqliteDatabase) => void) {
        connection.run("PRAGMA busy_timeout = 5000", (error) => done(error, connection));
      },
    },
  });
}

export const db = global.otsugeDb ?? createDb();
if (process.env.NODE_ENV !== "production") global.otsugeDb = db;

async function initialize() {
  if (!(await db.schema.hasTable("notifications"))) {
    await db.schema.createTable("notifications", (table) => {
      table.increments("id").primary();
      table.text("message").notNullable();
      table.string("start_time", 5).notNullable();
      table.string("end_time", 5).notNullable();
      table.integer("count_per_day").notNullable();
      table.integer("min_interval_minutes").notNullable();
      table.boolean("enabled").notNullable().defaultTo(true);
      table.timestamp("created_at").notNullable();
      table.timestamp("updated_at").notNullable();
    });
  }

  if (!(await db.schema.hasTable("subscriptions"))) {
    await db.schema.createTable("subscriptions", (table) => {
      table.increments("id").primary();
      table.text("endpoint").notNullable().unique();
      table.text("p256dh").notNullable();
      table.text("auth").notNullable();
      table.timestamp("created_at").notNullable();
    });
  }

  if (!(await db.schema.hasTable("schedules"))) {
    await db.schema.createTable("schedules", (table) => {
      table.increments("id").primary();
      table.integer("notification_id").notNullable().references("id").inTable("notifications").onDelete("CASCADE");
      table.timestamp("scheduled_at").notNullable().index();
      table.boolean("sent").notNullable().defaultTo(false);
      table.boolean("discarded").notNullable().defaultTo(false);
      table.boolean("manually_modified").notNullable().defaultTo(false);
      table.timestamp("created_at").notNullable();
      table.timestamp("updated_at").notNullable();
    });
  }

  if (!(await db.schema.hasTable("schedule_generation_locks"))) {
    try {
      await db.schema.createTable("schedule_generation_locks", (table) => {
        table.string("date", 10).primary();
      });
    } catch (error) {
      // Another backend may have created this table after hasTable completed.
      // Recheck outside a transaction so PostgreSQL DDL errors cannot poison it.
      if (!(await db.schema.hasTable("schedule_generation_locks"))) throw error;
    }
  }

  if (!(await db.schema.hasTable("quiet_hours"))) {
    await db.schema.createTable("quiet_hours", (table) => {
      table.increments("id").primary();
      table.string("start_time", 5).notNullable();
      table.string("end_time", 5).notNullable();
      table.boolean("enabled").notNullable().defaultTo(true);
      table.timestamp("created_at").notNullable();
      table.timestamp("updated_at").notNullable();
    });
  }

  if (!(await db.schema.hasTable("delivery_logs"))) {
    await db.schema.createTable("delivery_logs", (table) => {
      table.increments("id").primary();
      table.integer("schedule_id").references("id").inTable("schedules").onDelete("SET NULL");
      table.string("status", 16).notNullable();
      table.text("message").notNullable();
      table.timestamp("scheduled_at").notNullable();
      table.timestamp("sent_at").notNullable().index();
      table.integer("delivered_count").notNullable().defaultTo(0);
      table.integer("failed_count").notNullable().defaultTo(0);
      table.integer("removed_subscription_count").notNullable().defaultTo(0);
      table.timestamp("created_at").notNullable();
    });
  }
}

export async function readyDb() {
  global.otsugeDbReady ??= initialize();
  await global.otsugeDbReady;
  return db;
}

import type { Knex } from "knex";

export async function initializeSchema(database: Knex) {
  if (!(await database.schema.hasTable("notifications"))) {
    await database.schema.createTable("notifications", (table) => {
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

  if (!(await database.schema.hasTable("subscriptions"))) {
    await database.schema.createTable("subscriptions", (table) => {
      table.increments("id").primary();
      table.text("endpoint").notNullable().unique();
      table.text("p256dh").notNullable();
      table.text("auth").notNullable();
      table.timestamp("created_at").notNullable();
    });
  }

  if (!(await database.schema.hasTable("schedules"))) {
    await database.schema.createTable("schedules", (table) => {
      table.increments("id").primary();
      table.integer("notification_id").notNullable().references("id").inTable("notifications").onDelete("CASCADE");
      table.timestamp("scheduled_at").notNullable().index();
      table.boolean("sent").notNullable().defaultTo(false);
      table.boolean("discarded").notNullable().defaultTo(false);
      table.boolean("manually_modified").notNullable().defaultTo(false);
      table.string("delivery_lease_token", 36).nullable();
      table.timestamp("delivery_lease_expires_at").nullable();
      table.timestamp("created_at").notNullable();
      table.timestamp("updated_at").notNullable();
    });
  }

  await addLeaseColumn(database, "delivery_lease_token", (table) => {
    table.string("delivery_lease_token", 36).nullable();
  });
  await addLeaseColumn(database, "delivery_lease_expires_at", (table) => {
    table.timestamp("delivery_lease_expires_at").nullable();
  });

  if (!(await database.schema.hasTable("quiet_hours"))) {
    await database.schema.createTable("quiet_hours", (table) => {
      table.increments("id").primary();
      table.string("start_time", 5).notNullable();
      table.string("end_time", 5).notNullable();
      table.boolean("enabled").notNullable().defaultTo(true);
      table.timestamp("created_at").notNullable();
      table.timestamp("updated_at").notNullable();
    });
  }

  if (!(await database.schema.hasTable("delivery_logs"))) {
    await database.schema.createTable("delivery_logs", (table) => {
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

async function addLeaseColumn(
  database: Knex,
  name: string,
  addColumn: (table: Knex.CreateTableBuilder) => void,
) {
  if (await database.schema.hasColumn("schedules", name)) return;
  try {
    await database.schema.alterTable("schedules", addColumn);
  } catch (error) {
    // Another process may have completed the same additive upgrade meanwhile.
    if (!(await database.schema.hasColumn("schedules", name))) throw error;
  }
}

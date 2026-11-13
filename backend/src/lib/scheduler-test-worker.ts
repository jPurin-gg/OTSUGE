import { readyDb } from "./db";
import { generateDailySchedules } from "./scheduler";
import type { Knex } from "knex";

async function main() {
  const [date, role] = process.argv.slice(2);
  const database = await readyDb();
  Math.random = () => role === "holder" ? 0.75 : 0.25;

  let release: () => void;
  const released = new Promise<void>((resolve) => { release = resolve; });
  process.on("message", (message) => {
    if (message === "release") release();
  });

  // Transactions clone their client from its prototype. Patch that prototype in
  // this disposable process to pause real SQL without changing production code.
  const prototype = Object.getPrototypeOf(database.client) as Knex.Client;
  const query = prototype.query;
  prototype.query = async function (connection: unknown, statement: { sql: string } | string) {
    const sql = typeof statement === "string" ? statement : statement.sql;
    const pending = query.call(this, connection, statement);
    if (sql.startsWith("insert into `schedule_generation_locks`")) {
      process.send?.({ type: "lock-attempt" });
    }
    const result = await pending;
    if (sql.startsWith("select") && sql.includes("`notifications`")) {
      process.send?.({ type: "read" });
    }
    if (role === "holder" && sql.startsWith("delete from `schedules`")) {
      process.send?.({ type: "paused" });
      await released;
    }
    return result;
  };

  try {
    const result = await generateDailySchedules(database, date);
    process.send?.({ type: "result", result });
  } finally {
    await database.destroy();
  }
}

void main().catch((error) => {
  process.send?.({ type: "error", error: String(error) });
  process.exitCode = 1;
}).finally(() => {
  process.disconnect?.();
});

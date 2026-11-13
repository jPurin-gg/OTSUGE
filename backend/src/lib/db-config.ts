import type { Knex } from "knex";

export function getDatabaseConfig(): Knex.Config {
  const client = process.env.DB_CLIENT || "sqlite";
  if (client === "postgres") {
    const connection = process.env.DATABASE_URL;
    if (!connection) {
      throw new Error("データベースの必須環境変数が未設定または空です: DATABASE_URL");
    }
    return { client: "pg", connection, pool: { min: 1, max: 10 } };
  }
  if (client !== "sqlite") {
    throw new Error("DB_CLIENT は sqlite または postgres を指定してください。");
  }

  const filename = process.env.SQLITE_PATH;
  if (!filename) {
    throw new Error("データベースの必須環境変数が未設定または空です: SQLITE_PATH");
  }
  return { client: "sqlite3", connection: { filename }, useNullAsDefault: true };
}

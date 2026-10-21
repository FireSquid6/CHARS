import { SQL } from "bun";
import { drizzle } from "drizzle-orm/bun-sql";
import * as schema from "./schema";

/** Opens a pool without applying migrations or creating an import-time singleton. */
export function openDatabase(url: string | SQL.Options | undefined = process.env.DATABASE_URL) {
  if (!url) throw new Error("DATABASE_URL is required");
  const sql = typeof url === "string"
    ? new SQL(url, process.env.DATABASE_SOCKET ? { path: process.env.DATABASE_SOCKET } : {})
    : new SQL(url);
  return { db: drizzle(sql, { schema }), sql, close: () => sql.close() };
}

export type CharsDatabase = ReturnType<typeof openDatabase>["db"];

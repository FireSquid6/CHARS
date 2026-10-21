import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema";

/** Opens a connection without applying migrations or creating an import-time singleton. */
export function openDatabase(path = process.env.DATABASE_PATH ?? "chars.sqlite") {
  const sqlite = new Database(path, { create: true, strict: true });
  try {
    sqlite.exec("PRAGMA foreign_keys = ON;");
    sqlite.exec("PRAGMA busy_timeout = 5000;");
    sqlite.exec("PRAGMA journal_mode = WAL;");
    const db = drizzle(sqlite, { schema });
    return { db, sqlite, close: () => sqlite.close() };
  } catch (error) {
    sqlite.close();
    throw error;
  }
}

export type CharsDatabase = ReturnType<typeof openDatabase>["db"];

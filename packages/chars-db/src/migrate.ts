import { Database } from "bun:sqlite";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { configFromEnv, openDatabase } from "./index";

const migrationDirectory = join(import.meta.dir, "../migrations");

export async function migrate(db: Database): Promise<void> {
  db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at_utc TEXT NOT NULL)");
  const files = (await readdir(migrationDirectory)).filter(file => /^\d+_[a-z_]+\.sql$/.test(file)).sort();
  const known = new Set(db.query<{ version: string }, []>("SELECT version FROM schema_migrations").all().map(row => row.version));
  const record = db.query<void, [string, string]>("INSERT INTO schema_migrations (version, applied_at_utc) VALUES (?, ?)");
  for (const file of files) {
    if (known.has(file)) continue;
    const sql = await Bun.file(join(migrationDirectory, file)).text();
    db.transaction(() => {
      db.exec(sql);
      record.run(file, new Date().toISOString());
    })();
  }
}

if (import.meta.main) {
  const db = openDatabase(configFromEnv());
  try {
    await migrate(db);
    console.log("Database migrations applied");
  } finally {
    db.close();
  }
}

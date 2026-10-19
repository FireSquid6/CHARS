import { Database } from "bun:sqlite";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { configFromEnv, openDatabase } from "./index";

const migrationDirectory = join(import.meta.dir, "../migrations");

export async function migrate(db: Database): Promise<void> {
  const files = (await readdir(migrationDirectory)).filter(file => /^\d+_[a-z_]+\.sql$/.test(file)).sort();
  const migrations = await Promise.all(files.map(async file => ({ file, sql: await Bun.file(join(migrationDirectory, file)).text() })));
  if (db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()?.foreign_keys !== 1) {
    throw new Error("Migrations require a connection with foreign keys enabled");
  }
  // SQLite cannot disable foreign keys inside a transaction. Rebuild referenced
  // tables under an exclusive writer lock; verify links before committing.
  db.exec("PRAGMA foreign_keys = OFF");
  let started = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    started = true;
    db.exec("CREATE TABLE IF NOT EXISTS schema_migrations (version TEXT PRIMARY KEY, applied_at_utc TEXT NOT NULL)");
    const known = new Set(db.query<{ version: string }, []>("SELECT version FROM schema_migrations").all().map(row => row.version));
    const record = db.query<void, [string, string]>("INSERT INTO schema_migrations (version, applied_at_utc) VALUES (?, ?)");
    for (const { file, sql } of migrations) {
      if (known.has(file)) continue;
      db.exec(sql);
      const violations = db.query("PRAGMA foreign_key_check").all();
      if (violations.length) throw new Error(`Migration ${file} leaves ${violations.length} foreign key violation(s)`);
      const crossSeason = db.query(`
        SELECT 1 FROM snapshots AS s JOIN poll_releases AS p ON p.id = s.poll_release_id WHERE p.season <> s.season
        UNION ALL
        SELECT 1 FROM snapshot_games AS sg JOIN snapshots AS s ON s.snapshot_key = sg.snapshot_key AND s.revision = sg.snapshot_revision
        JOIN games AS g ON g.id = sg.game_id WHERE g.season <> s.season
        LIMIT 1
      `).get();
      if (crossSeason) throw new Error(`Migration ${file} found cross-season snapshot inputs`);
      record.run(file, new Date().toISOString());
    }
    db.exec("COMMIT");
    started = false;
  } catch (error) {
    if (started) db.exec("ROLLBACK");
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
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

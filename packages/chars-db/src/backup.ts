import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { open, rename, rm, stat } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

/** SQLite's VACUUM INTO reads a consistent transaction including committed WAL frames.
 * The source sidecar cache is separate: archive it with the sync worker stopped. */
export async function backup(source: string, destination: string): Promise<void> {
  if (!isAbsolute(source) || !isAbsolute(destination) || source === destination) throw new Error("Source and destination must be distinct absolute paths");
  try { await stat(destination); throw new Error("Backup destination already exists"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  const staged = `${destination}.${randomUUID()}.tmp`;
  const db = new Database(source, { readonly: true, strict: true });
  try {
    db.query("VACUUM INTO ?").run(staged);
    const check = new Database(staged, { readonly: true, strict: true });
    try {
      if (check.query<{ integrity_check: string }, []>("PRAGMA integrity_check").all().some(r => r.integrity_check !== "ok") ||
        check.query("PRAGMA foreign_key_check").all().length) throw new Error("Backup integrity validation failed");
    } finally { check.close(); }
    const file = await open(staged, "r");
    try { await file.sync(); } finally { await file.close(); }
    await rename(staged, destination);
    const folder = await open(dirname(destination), "r");
    try { await folder.sync(); } finally { await folder.close(); }
  } finally { db.close(); await rm(staged, { force: true }); }
}
if (import.meta.main) {
  const source = process.env.DATABASE_PATH, destination = process.argv[2];
  if (!source || !destination) throw new Error("Usage: DATABASE_PATH=/absolute/path bun run db:backup /absolute/new/path");
  await backup(source, destination);
  console.log("Verified WAL-consistent SQLite backup created. Archive CHARS_CACHE_PATH separately with sync stopped.");
}

/** VACUUM INTO captures a consistent committed SQLite snapshot, including WAL commits. */
import { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { access, copyFile, link, unlink } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { configFromEnv } from "./index";

async function exists(path: string) {
  try { await access(path); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
}

export function verifyDatabase(path: string) {
  const db = new Database(path, { readonly: true, strict: true });
  try {
    const integrity = db.query<{ integrity_check: string }, []>("PRAGMA integrity_check").all();
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== "ok" || db.query("PRAGMA foreign_key_check").all().length)
      throw new Error("Backup failed SQLite integrity or foreign-key check");
  } finally { db.close(); }
}

export async function backup(source: string, destination: string) {
  if (!isAbsolute(source) || !isAbsolute(destination) || source === destination) throw new Error("Use distinct absolute database paths");
  if (!await exists(source)) throw new Error("Source database does not exist");
  if (await exists(destination)) throw new Error("Destination already exists");
  const temp = `${destination}.tmp-${randomUUID()}`;
  const db = new Database(source, { readonly: true, strict: true });
  try {
    db.query("VACUUM INTO ?").run(temp);
    verifyDatabase(temp);
    // Link is atomic and refuses to replace a concurrent destination.
    await link(temp, destination);
  } finally { db.close(); if (await exists(temp)) await unlink(temp); }
  return destination;
}

export async function restore(source: string, destination: string) {
  if (!isAbsolute(source) || !isAbsolute(destination) || source === destination) throw new Error("Use distinct absolute database paths");
  if (!await exists(source)) throw new Error("Backup file does not exist");
  // Never overwrite a live DB or orphan WAL/SHM: these can contain committed data.
  if (await exists(destination) || await exists(`${destination}-wal`) || await exists(`${destination}-shm`))
    throw new Error("Restore target must be empty (including -wal and -shm); stop services and archive the complete old DB set first");
  verifyDatabase(source);
  const temp = `${destination}.tmp-${randomUUID()}`;
  try {
    await copyFile(source, temp, constants.COPYFILE_EXCL);
    verifyDatabase(temp);
    await link(temp, destination);
  } finally { if (await exists(temp)) await unlink(temp); }
  return destination;
}

if (import.meta.main) {
  try {
    const [action, path] = process.argv.slice(2);
    if (!path || !["backup", "restore"].includes(action ?? "")) throw new Error("Usage: bun run db:backup|db:restore /absolute/path/to/file.sqlite");
    const database = configFromEnv().path;
    console.log(await (action === "backup" ? backup(database, path) : restore(path, database)));
  } catch (error) { console.error(error instanceof Error ? error.message : "SQLite operation failed"); process.exitCode = 1; }
}

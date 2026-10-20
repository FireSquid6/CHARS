import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createCfbdClient } from "./cfbd";
import { ingest } from "./ingest";
import { openDatabase } from "./database";
import { buildSnapshots, publishSnapshots } from "./snapshots";
import { readSeason } from "./repository";
import type { SourceGameMetadata } from "./repository";

export function localKey(now = new Date(), timezone = "America/Chicago"): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const find = (type: string) => parts.find(p => p.type === type)?.value;
  return `${find("year")}-${find("month")}-${find("day")}`;
}
export function footballSeason(now = new Date(), timezone = "America/Chicago"): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "numeric" }).formatToParts(now);
  const year = Number(parts.find(p => p.type === "year")?.value), month = Number(parts.find(p => p.type === "month")?.value);
  return month < 7 ? year - 1 : year;
}

async function load<T>(path: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return fallback; throw e; }
}
async function save(path: string, value: unknown) {
  const temp = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temp, JSON.stringify(value), { flag: "wx" }); await rename(temp, path); }
  finally { await rm(temp, { force: true }); }
}
export async function withLease<T>(cache: string, work: () => Promise<T>): Promise<T> {
  await mkdir(cache, { recursive: true });
  const path = join(cache, "sync.lock"), token = randomUUID();
  for (let attempt = 0; ; attempt++) {
    try { await mkdir(path); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const age = Date.now() - (await stat(path)).mtimeMs;
      if (age < 3 * 60 * 60 * 1000 || attempt > 0) throw new Error("Another sync owns the lease; stale lease requires operator review");
      // Rename before removal: never delete a newly acquired lock after a failed rename.
      const stale = `${path}.stale.${token}`;
      await rename(path, stale);
      await rm(stale, { recursive: true });
    }
  }
  try { await writeFile(join(path, "owner"), token); return await work(); }
  finally { if (await readFile(join(path, "owner"), "utf8").catch(() => "") === token) await rm(path, { recursive: true, force: true }); }
}

export async function syncSeason(season: number, cache: string): Promise<{ changed: boolean; coverage: string[] }> {
  const client = createCfbdClient();
  const input = await client.season(season);
  const connection = openDatabase();
  try {
    const audit = await ingest(connection.sqlite, season, input, cache);
    const changed = audit.material;
    // Do not replace the previous publication when a classification or timing gap exists.
    if (!audit.coverage.length && changed) {
      const metadata = await load<Record<string, SourceGameMetadata>>(join(cache, "source", `${season}-games.json`), {});
      const snapshots = buildSnapshots(readSeason(connection.sqlite, season, metadata));
      await publishSnapshots(join(cache, "snapshots"), season, snapshots);
    }
    if (audit.coverage.length) throw new Error(`Season ${season} has ${audit.coverage.length} source coverage gaps; prior publication retained`);
    return { changed, coverage: audit.coverage };
  } finally { connection.close(); }
}

type Run = { key: string; seasons: number[]; startedAtUtc: string; endedAtUtc?: string; status: "running" | "success" | "failed"; error?: string };
export async function runDaily(cache: string, key: string, seasons: number[], retry = false): Promise<void> {
  await withLease(cache, async () => {
    const folder = join(cache, "runs"); await mkdir(folder, { recursive: true });
    const path = join(folder, `${key}.json`), previous = await load<Run | null>(path, null);
    if (previous?.status === "success" && !retry) return;
    if (previous?.status === "running" && Date.now() - Date.parse(previous.startedAtUtc) < 3 * 60 * 60 * 1000) throw new Error("Run already active");
    const run: Run = { key, seasons: previous?.seasons ?? seasons, startedAtUtc: new Date().toISOString(), status: "running" };
    await save(path, run);
    try {
      for (const season of run.seasons) await syncSeason(season, cache);
      await save(path, { ...run, status: "success", endedAtUtc: new Date().toISOString() });
    } catch (error) {
      await save(path, { ...run, status: "failed", endedAtUtc: new Date().toISOString(), error: error instanceof Error ? error.message : "Unknown error" });
      throw error;
    }
  });
}

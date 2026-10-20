import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createCfbdClient } from "./cfbd";
import type { Input } from "./ingest";
import { digest, ingest } from "./ingest";
import { openDatabase } from "./database";
import { buildSnapshots, publishSnapshots } from "./snapshots";
import { auditedSeason } from "./source";

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
  const ownerPath = join(path, "owner");
  const owner = { token, pid: process.pid };
  async function isOwner() {
    const current = await load<{ token?: string } | null>(ownerPath, null);
    return current?.token === token;
  }
  for (let attempt = 0; ; attempt++) {
    try { await mkdir(path); break; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const age = Date.now() - (await stat(path)).mtimeMs;
      if (age < 3 * 60 * 60 * 1000 || attempt > 0) throw new Error("Another sync owns the lease; stale lease requires operator review");
      const previous = await load<{ pid?: number } | null>(ownerPath, null);
      if (previous) {
        if (!Number.isSafeInteger(previous.pid) || previous.pid! < 1) throw new Error("Stale lease owner is invalid; operator review required");
        try { process.kill(previous.pid!, 0); throw new Error("Lease owner is still alive; refusing to steal a long-running sync"); }
        catch (e) { if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e; }
      }
      // Reclaim only after the owner process is gone (single-host local filesystem).
      const stale = `${path}.stale.${token}`;
      await rename(path, stale);
      await rm(stale, { recursive: true });
    }
  }
  let heartbeat: Promise<void> = Promise.resolve(), lost: Error | null = null;
  try {
    await writeFile(ownerPath, JSON.stringify(owner), { flag: "wx" });
    const timer = setInterval(() => {
      heartbeat = heartbeat.then(async () => {
        if (!await isOwner()) throw new Error("Sync lease ownership lost");
        const now = new Date(); await utimes(path, now, now);
      }).catch(error => { lost = error instanceof Error ? error : new Error("Sync lease heartbeat failed"); });
    }, 30_000);
    timer.unref();
    try {
      const result = await work();
      await heartbeat;
      if (lost) throw lost;
      if (!await isOwner()) throw new Error("Sync lease ownership lost");
      return result;
    } finally { clearInterval(timer); await heartbeat; }
  } finally { if (await isOwner()) await rm(path, { recursive: true, force: true }); }
}

export async function syncSeason(season: number, cache: string, options: {
  client?: { season(year: number): Promise<Input> };
  databasePath?: string;
  now?: Date;
} = {}): Promise<{ changed: boolean; coverage: string[] }> {
  const now = options.now ?? new Date();
  if (!Number.isFinite(now.getTime())) throw new Error("Invalid sync time");
  const zone = process.env.SYNC_TIMEZONE ?? "America/Chicago";
  const active = season === footballSeason(now, zone);
  const client = options.client ?? createCfbdClient();
  const input = await client.season(season);
  const connection = openDatabase(options.databasePath);
  try {
    const audit = await ingest(connection.sqlite, season, input, cache);
    const changed = audit.material;
    const blocking = audit.coverage.filter(gap => !active || gap !== "No AP/CFP poll data");
    if (blocking.length) throw new Error(`Season ${season} has ${blocking.length} source coverage gaps; prior publication retained`);
    const { source, calendar } = await auditedSeason(connection.sqlite, season, cache);
    const folder = join(cache, "snapshots", String(season));
    const calendarHash = digest(calendar);
    const published = await load<unknown>(join(folder, "current.json"), null);
    const marker = await load<{ calendarHash: string; asOfDay?: string; weekBoundary?: string } | null>(join(folder, "source-state.json"), null);
    const asOfDay = active ? localKey(now, zone) : undefined;
    // In addition to the local-day boundary, detect a week starting or a
    // week-final cutoff crossing between two manual runs on the same day.
    const boundaries = active ? [...new Set(source.games.filter(game => game.applicationGameType === "regular" && game.kickoffUtc)
      .map(game => ({ week: game.week, kickoff: Date.parse(game.kickoffUtc!) }))
      .filter(game => game.week !== null))] : [];
    const starts = new Map<number, number>();
    for (const { week, kickoff } of boundaries) starts.set(week!, Math.min(starts.get(week!) ?? Infinity, kickoff));
    const ordered = [...starts.values()].sort((a, b) => a - b);
    const weekEdges = ordered.flatMap((start, index) => [start, ordered[index + 1] ?? Math.max(start, ...boundaries.filter(game => starts.get(game.week!) === start).map(game => game.kickoff)) + 7 * 86400000]);
    for (const cutoff of [calendar.freezeUtc, calendar.firstCcgUtc]) if (cutoff) weekEdges.push(Date.parse(cutoff));
    const weekBoundary = active ? String(Math.max(0, ...weekEdges.filter(edge => edge <= now.getTime()))) : undefined;
    // A failed publication can leave a manifest but not the marker; rebuild in that case.
    if (changed || published === null || marker?.calendarHash !== calendarHash || marker?.asOfDay !== asOfDay || marker?.weekBoundary !== weekBoundary) {
      const snapshots = active ? buildSnapshots(source, calendar, now.toISOString()) : buildSnapshots(source, calendar);
      await publishSnapshots(join(cache, "snapshots"), season, snapshots);
      await save(join(folder, "source-state.json"), { calendarHash, asOfDay, weekBoundary });
    }
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

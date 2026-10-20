/** Durable daily/manual ingestion. Scheduler supplies wall-clock invocation; all stored times are UTC. */
import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { createClient } from "chars-cfbd";
import { configFromEnv, openDatabase, transaction } from "./index";
import { currentFootballSeason, fetchSeason, ingestSeason, type SeasonInput } from "./ingest";
import { migrate } from "./migrate";
import { rebuildSnapshots, planSnapshots, publishedSnapshot } from "./snapshots";

type Run = { id: string; state: string; started_at_utc: string; planned_current_season: number | null;
  planned_recent_seasons: number | null; planned_timezone: string | null };
const one = <T>(db: Database, sql: string, ...args: (string | number)[]) => db.query(sql).get(...args) as T | null;
const all = <T>(db: Database, sql: string, ...args: (string | number)[]) => db.query(sql).all(...args) as T[];
const iso = (date: Date) => date.toISOString();
const leaseName = "cfbd:sync";
const leaseMs = 60 * 60 * 1000;

export function scheduledKey(now: Date, timezone = "America/Chicago"): string {
  if (Number.isNaN(now.getTime())) throw new Error("Invalid sync date");
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  const field = (name: string) => parts.find(part => part.type === name)?.value;
  return `daily:${field("year")}-${field("month")}-${field("day")}`;
}

type Plan = { current: number; recent: number; timezone: string };
function planFor(key: string, now: Date, timezone: string): Plan {
  // A scheduled retry belongs to its original local date, not the day of the retry.
  const scheduled = key.startsWith("daily:");
  const date = scheduled ? new Date(`${key.slice(6)}T12:00:00Z`) : now;
  const current = currentFootballSeason(date);
  const recent = !scheduled || date.getUTCDay() === 0 ? 2 : 0;
  return { current, recent, timezone };
}

export function claimSync(db: Database, key: string, now = new Date(), plan?: Plan): string | null {
  if (!/^(daily:\d{4}-\d{2}-\d{2}|manual:[\w-]+)$/.test(key)) throw new Error("Invalid sync key");
  const owner = randomUUID(), stamp = iso(now);
  return transaction(db, () => {
    const lease = one<{ owner: string; expires_at_utc: string }>(db, "SELECT * FROM job_leases WHERE name=?", leaseName);
    if (lease && lease.expires_at_utc > stamp) return null;
    const existing = one<Run>(db, "SELECT * FROM sync_runs WHERE scheduled_key=?", key);
    if (existing?.state === "success") return null;
    db.query(`INSERT INTO job_leases (name,owner,expires_at_utc) VALUES (?,?,?)
      ON CONFLICT(name) DO UPDATE SET owner=excluded.owner,expires_at_utc=excluded.expires_at_utc`)
      .run(leaseName, owner, iso(new Date(now.getTime() + leaseMs)));
    // An abandoned run is explicitly closed before a replacement is admitted.
    db.query(`UPDATE sync_runs SET state='failure', ended_at_utc=?,error='Worker lease expired before completion'
      WHERE state='running'`).run(stamp);
    const planned = existing?.planned_current_season !== null && existing?.planned_current_season !== undefined &&
      existing.planned_recent_seasons !== null ? { current: existing.planned_current_season,
        recent: existing.planned_recent_seasons, timezone: existing.planned_timezone ?? "America/Chicago" } :
      plan ?? planFor(key, now, "America/Chicago");
    db.query(`INSERT INTO sync_runs (id,scheduled_key,state,started_at_utc,planned_current_season,planned_recent_seasons,planned_timezone)
      VALUES (?,?,'running',?,?,?,?)
      ON CONFLICT(scheduled_key) DO UPDATE SET id=excluded.id,state='running',started_at_utc=excluded.started_at_utc,
        ended_at_utc=NULL,counts_json='{}',error=NULL,planned_current_season=excluded.planned_current_season,
        planned_recent_seasons=excluded.planned_recent_seasons,planned_timezone=excluded.planned_timezone`)
      .run(owner, key, stamp, planned.current, planned.recent, planned.timezone);
    return owner;
  });
}

function assertLease(db: Database, owner: string, now = new Date()) {
  const lease = one<{ owner: string; expires_at_utc: string }>(db, "SELECT owner,expires_at_utc FROM job_leases WHERE name=?", leaseName);
  if (lease?.owner !== owner || lease.expires_at_utc <= iso(now)) throw new Error("Sync lease lost or expired");
}

function renew(db: Database, owner: string, now = new Date()) {
  transaction(db, () => {
    assertLease(db, owner, now);
    db.query("UPDATE job_leases SET expires_at_utc=? WHERE name=? AND owner=?")
      .run(iso(new Date(now.getTime() + leaseMs)), leaseName, owner);
  });
}

function finish(db: Database, owner: string, state: "success" | "failure", counts: unknown, error?: string) {
  transaction(db, () => {
    // Never overwrite another worker's recovered run.
    if (one<{ owner: string }>(db, "SELECT owner FROM job_leases WHERE name=?", leaseName)?.owner !== owner) return;
    db.query("UPDATE sync_runs SET state=?,ended_at_utc=?,counts_json=?,error=? WHERE id=? AND state='running'")
      .run(state, iso(new Date()), JSON.stringify(counts), error ?? null, owner);
    db.query("DELETE FROM job_leases WHERE name=? AND owner=?").run(leaseName, owner);
  });
}

type Fingerprint = { id: string; kickoff_utc: string | null; week: number | null; payload_hash: string };
function previousGames(db: Database, year: number) {
  return new Map(all<Fingerprint>(db, "SELECT id,kickoff_utc,week,payload_hash FROM games WHERE season=?", year)
    .map(row => [row.id, row]));
}
function earliestChange(db: Database, year: number, before: Map<string, Fingerprint>, input: SeasonInput): string | undefined {
  let earliest: string | undefined;
  const consider = (time: string | null | undefined) => { if (!time) earliest = undefined; else if (earliest !== undefined && time < earliest) earliest = time; };
  // Initial load or membership/coverage changes need the entire season.
  if (!before.size) return undefined;
  earliest = "9999-12-31T00:00:00.000Z";
  for (const game of input.games.items) {
    const old = before.get(`cfbd:${game.id}`);
    const next = one<Fingerprint>(db, "SELECT id,kickoff_utc,week,payload_hash FROM games WHERE id=?", `cfbd:${game.id}`);
    if (next && (!old || old.payload_hash !== next.payload_hash || old.week !== next.week)) {
      consider(old?.kickoff_utc); consider(next.kickoff_utc);
    }
  }
  // Poll/calendar/membership corrections may change an earlier selection independent of game dates.
  const invalidations = all<{ reason: string; input_id: string }>(db, `SELECT reason,input_id FROM snapshot_input_invalidations
    WHERE snapshot_key IN (SELECT snapshot_key FROM snapshots WHERE season=?)`, year);
  for (const row of invalidations) {
    if (row.reason.startsWith("game_")) continue;
    if (row.reason.startsWith("poll_")) {
      const release = one<{ effective_at_utc: string | null }>(db, "SELECT effective_at_utc FROM poll_releases WHERE id=?", row.input_id);
      // Poll corrections can affect any snapshot after the preceding game's week.
      consider(release?.effective_at_utc ? new Date(Date.parse(release.effective_at_utc) - 14 * 86400000).toISOString() : null);
    } else { earliest = undefined; break; }
  }
  return earliest === "9999-12-31T00:00:00.000Z" ? undefined : earliest;
}

export type SyncOptions = { key: string; now?: Date; currentSeason?: number; recentSeasons?: number;
  timezone?: string; fetch?: (year: number) => Promise<SeasonInput>; afterClaim?: () => Promise<void> };

export function syncHealth(db: Database) {
  return { lease: one<{ owner: string; expires_at_utc: string }>(db,
    "SELECT owner,expires_at_utc FROM job_leases WHERE name=?", leaseName),
    lastRun: one<Run & { scheduled_key: string; ended_at_utc: string | null; counts_json: string; error: string | null }>(db,
      "SELECT * FROM sync_runs ORDER BY started_at_utc DESC LIMIT 1"),
    lastSuccess: one<Run & { scheduled_key: string; ended_at_utc: string | null }>(db,
      "SELECT * FROM sync_runs WHERE state='success' ORDER BY ended_at_utc DESC LIMIT 1"),
    pendingScenarios: one<{ count: number }>(db,
      "SELECT COUNT(*) AS count FROM scenario_work_queue WHERE state='pending'")?.count ?? 0 };
}

export async function syncData(db: Database, options: SyncOptions) {
  const now = options.now ?? new Date();
  const timezone = options.timezone ?? "America/Chicago";
  const defaultPlan = planFor(options.key, now, timezone);
  const owner = claimSync(db, options.key, now, { current: options.currentSeason ?? defaultPlan.current,
    recent: options.recentSeasons ?? defaultPlan.recent, timezone });
  if (!owner) return { skipped: true, key: options.key };
  const counts = { seasons: [] as number[], inserted: 0, revised: 0, published: [] as string[], queued: 0 };
  try {
    await options.afterClaim?.();
    const planned = one<Run>(db, "SELECT * FROM sync_runs WHERE id=?", owner)!;
    const current = planned.planned_current_season!;
    const recent = planned.planned_recent_seasons!;
    if (!Number.isSafeInteger(current) || current < 1998 || !Number.isSafeInteger(recent) || recent < 0 || recent > 5)
      throw new Error("Invalid sync season range");
    const fetcher = options.fetch ?? fetchSeason.bind(null, createClient());
    for (let year = current - recent; year <= current; year++) {
      renew(db, owner);
      const input = await fetcher(year); // No network or retry sleep in a write transaction.
      renew(db, owner);
      const before = previousGames(db, year);
      const priorGeneration = one<{ generation: number }>(db,
        "SELECT generation FROM season_input_generations WHERE season=?", year)?.generation ?? 0;
      if (before.size && input.games.items.length === 0)
        throw new Error(`Empty game response for previously populated season ${year}; previous data preserved`);
      const report = transaction(db, () => { assertLease(db, owner); return ingestSeason(db, year, input); });
      counts.seasons.push(year); counts.inserted += report.inserted; counts.revised += report.revised;
      const from = earliestChange(db, year, before, input);
      const plans = planSnapshots(db, year, iso(now));
      const needsBuild = report.inserted + report.revised + report.pollReleases > 0 ||
        plans.some(plan => !publishedSnapshot(db, plan.key) ||
          one<{ state: string; game_cutoff_utc: string }>(db, `SELECT p.state,s.game_cutoff_utc FROM snapshot_publications p
            JOIN snapshots s ON s.snapshot_key=p.snapshot_key AND s.revision=p.revision WHERE p.snapshot_key=?`, plan.key)?.game_cutoff_utc !== plan.gameCutoff ||
          one<{ state: string }>(db, "SELECT state FROM snapshot_publications WHERE snapshot_key=?", plan.key)?.state !== "current");
      if (needsBuild) {
        const result = rebuildSnapshots(db, year, iso(now), {
          ...(from ? { fromCutoffUtc: from } : {}), beforePublish: () => renew(db, owner)
        });
        counts.published.push(...result.published);
      }
      // Queue revision-specific work even after a crash between publication and enqueue.
      transaction(db, () => {
        assertLease(db, owner);
        db.query(`INSERT OR IGNORE INTO scenario_work_queue (snapshot_key,snapshot_revision,state,updated_at_utc)
          SELECT s.snapshot_key,s.revision,'pending',? FROM snapshot_publications p
          JOIN snapshots s ON s.snapshot_key=p.snapshot_key AND s.revision=p.revision
          WHERE s.season=? AND s.kind<>'selection_final' AND p.state='current'`).run(iso(new Date()), year);
        // A fixed weekly ranking can still have a different remaining schedule after reconciliation.
        db.query(`UPDATE scenario_work_queue SET state='pending',attempts=0,next_eligible_utc=NULL,
          error=NULL,updated_at_utc=? WHERE snapshot_key IN
          (SELECT snapshot_key FROM snapshots WHERE season=?) AND state IN ('done','failure')
          AND snapshot_revision IN (SELECT revision FROM snapshot_publications WHERE snapshot_key=scenario_work_queue.snapshot_key)
          AND EXISTS (SELECT 1 FROM season_input_generations WHERE season=? AND generation>?)`)
          .run(iso(new Date()), year, year, priorGeneration);
        counts.queued = one<{ count: number }>(db, "SELECT COUNT(*) AS count FROM scenario_work_queue WHERE state='pending'")?.count ?? 0;
      });
    }
    finish(db, owner, "success", counts);
    return { skipped: false, key: options.key, ...counts };
  } catch (error) {
    finish(db, owner, "failure", counts, error instanceof Error ? error.message : "Unknown sync failure");
    throw error;
  }
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    const timezone = process.env.SYNC_TIMEZONE ?? "America/Chicago";
    const now = new Date();
    const key = args.length === 0 ? scheduledKey(now, timezone) :
      args.length === 1 && args[0] === "--manual" ? `manual:${randomUUID()}` :
      args.length === 2 && args[0] === "--retry" ? args[1]! : null;
    if (!key && !(args.length === 1 && args[0] === "--status"))
      throw new Error("Usage: bun run data:sync [--manual | --retry daily:YYYY-MM-DD | --status]");
    const db = openDatabase(configFromEnv());
    try { await migrate(db); console.log(JSON.stringify(key ? await syncData(db, { key, now, timezone }) : syncHealth(db), null, 2)); }
    finally { db.close(); }
  } catch (error) { console.error(error instanceof Error ? error.message : "Sync failed"); process.exitCode = 1; }
}

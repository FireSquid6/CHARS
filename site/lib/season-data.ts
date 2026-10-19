import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";

export type SeasonState = "preseason" | "current" | "final" | "incomplete";
export type SeasonCard = { year: number; state: SeasonState; detail: string };
export type SnapshotOption = {
  key: string; revision: number; week: number | null; kind: "partial" | "week_final" | "selection_final";
  gameCutoff: string; pollCutoff: string | null; publishedAt: string; publicationState: "current" | "pending" | "stale";
  coverage: { complete: boolean; reasons: string[]; poll?: { type: string; fallback: boolean; timingProvenance: string } | null };
};
export type Ranking = {
  teamId: string; name: string; abbreviation: string | null; membership: string;
  wins: number; losses: number; ties: number; rating: number; colleyRank: number; adjustedRank: number | null;
  eligible: boolean; eligibilityReason: string | null; originalRoute: string; finalCategory: "bid" | "playin" | "outside";
};
export type Swap = { sequence: number; winner: string; loser: string; supportingGameIds: string[];
  winnerBefore: string; loserBefore: string };
export type SeasonData = { year: number; state: SeasonState; options: SnapshotOption[]; snapshot: SnapshotOption | null;
  rankings: Ranking[]; swaps: Swap[]; issue: string | null; lastSync: string | null; pending: boolean };

type DbSnapshot = { snapshot_key: string; revision: number; week: number | null; kind: SnapshotOption["kind"];
  game_cutoff_utc: string; poll_cutoff_utc: string | null; published_at_utc: string;
  state: SnapshotOption["publicationState"]; coverage_json: string };

// July starts the football season; January–June still belong to the prior season.
export function currentFootballSeason(now = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", year: "numeric", month: "numeric" }).formatToParts(now);
  const year = Number(parts.find(part => part.type === "year")?.value);
  const month = Number(parts.find(part => part.type === "month")?.value);
  return month >= 7 ? year : year - 1;
}

export function supportedYears(now = new Date(), start = Number(process.env.START_SEASON ?? 1998)): number[] {
  if (!Number.isSafeInteger(start) || start < 1869 || start > currentFootballSeason(now)) return [];
  return Array.from({ length: currentFootballSeason(now) - start + 1 }, (_, index) => currentFootballSeason(now) - index);
}

function openReadOnly(): { db: Database | null; issue: string | null } {
  const path = process.env.DATABASE_PATH;
  if (!path || !isAbsolute(path)) return { db: null, issue: "Set DATABASE_PATH to an absolute SQLite file path, then migrate and backfill seasons." };
  if (!existsSync(path)) return { db: null, issue: "Database not found. Run bun run db:migrate and backfill season data." };
  try {
    const db = new Database(path, { readonly: true, strict: true });
    db.exec("PRAGMA query_only = ON");
    db.exec("PRAGMA busy_timeout = 5000");
    if (!db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' AND name='snapshot_publications'").get()) {
      db.close();
      return { db: null, issue: "Database migrations are required. Run bun run db:migrate." };
    }
    return { db, issue: null };
  } catch {
    return { db: null, issue: "Unable to read the SQLite database. Check DATABASE_PATH, permissions, and migrations." };
  }
}

function snapshotOptions(db: Database, year: number): SnapshotOption[] {
  const rows = db.query<DbSnapshot, [number]>(`SELECT s.snapshot_key, s.revision, s.week, s.kind, s.game_cutoff_utc,
    s.poll_cutoff_utc, s.published_at_utc, p.state, s.coverage_json
    FROM snapshot_publications p JOIN snapshots s ON s.snapshot_key=p.snapshot_key AND s.revision=p.revision
    WHERE s.season=? AND (p.state='current' OR s.kind='selection_final')
    ORDER BY s.game_cutoff_utc DESC, CASE s.kind WHEN 'selection_final' THEN 0 WHEN 'week_final' THEN 1 ELSE 2 END,
    s.published_at_utc DESC`).all(year);
  return rows.map(row => {
    let coverage: SnapshotOption["coverage"] = { complete: false, reasons: ["Coverage metadata unavailable"] };
    try {
      const parsed: unknown = JSON.parse(row.coverage_json);
      if (parsed && typeof parsed === "object" && "complete" in parsed && "reasons" in parsed) {
        const data = parsed as SnapshotOption["coverage"];
        if (typeof data.complete === "boolean" && Array.isArray(data.reasons)) coverage = data;
      }
    } catch { /* Treat invalid coverage as incomplete. */ }
    return { key: row.snapshot_key, revision: row.revision, week: row.week, kind: row.kind,
      gameCutoff: row.game_cutoff_utc, pollCutoff: row.poll_cutoff_utc, publishedAt: row.published_at_utc,
      publicationState: row.state, coverage };
  });
}

function hasPendingPublication(db: Database, year: number): boolean {
  return Boolean(db.query<{ snapshot_key: string }, [number]>(`SELECT p.snapshot_key FROM snapshot_publications p
    JOIN snapshots s ON s.snapshot_key=p.snapshot_key AND s.revision=p.revision
    WHERE s.season=? AND p.state='pending' LIMIT 1`).get(year));
}

function seasonState(year: number, options: SnapshotOption[], current: number): SeasonState {
  if (options.some(option => option.kind === "selection_final" && option.publicationState === "current" && option.coverage.complete)) return "final";
  if (year < current) return "incomplete";
  const latest = options.find(option => option.publicationState === "current");
  if (!latest || latest.key.endsWith(":preseason")) return "preseason";
  return latest.coverage.complete ? "current" : "incomplete";
}

export function getHomeData(now = new Date()): { seasons: SeasonCard[]; setup: string | null } {
  const years = supportedYears(now);
  const { db, issue } = openReadOnly();
  try {
    const cards = years.map(year => {
      const options = db ? snapshotOptions(db, year) : [];
      const state = seasonState(year, options, currentFootballSeason(now));
      const latest = options.find(option => option.publicationState === "current");
      return { year, state, detail: state === "final" ? "Pre-championship selection available" :
        db && hasPendingPublication(db, year) ? "Updated snapshot pending validation" :
        !latest ? "No published snapshot yet" : latest.kind === "partial" ?
          latest.key.endsWith(":preseason") ? "Awaiting first game" : "Partial week available" :
          `Latest published: Week ${latest.week ?? "—"}` };
    });
    return { seasons: cards, setup: issue ?? (process.env.CFBD_API_KEY ? null :
      "CFBD_API_KEY is missing. Existing snapshots remain viewable; new seasons require a server-side API key and backfill.") };
  } catch {
    return { seasons: years.map(year => ({ year, state: year === currentFootballSeason(now) ? "preseason" : "incomplete", detail: "Database unavailable" })),
      setup: "Unable to read published seasons. Check SQLite migrations and database access." };
  } finally { db?.close(); }
}

export function getSeasonData(year: number, requestedWeek?: string): SeasonData {
  const { db, issue } = openReadOnly();
  const empty = (message: string): SeasonData => ({ year, state: year === currentFootballSeason() ? "preseason" : "incomplete",
    options: [], snapshot: null, rankings: [], swaps: [], issue: message, lastSync: null, pending: false });
  if (!db) return empty(issue ?? "Database unavailable");
  try {
    // One consistent WAL read: ranking rows and the pointer always refer to the same publication.
    return db.transaction(() => {
      const options = snapshotOptions(db, year);
      const pending = hasPendingPublication(db, year);
      const final = options.find(o => o.kind === "selection_final" && o.publicationState === "current" && o.coverage.complete);
      const selected = requestedWeek !== undefined ? options.find(o => o.key === requestedWeek) :
        final ?? options.find(o => o.publicationState === "current" && o.coverage.complete) ??
        options.find(o => o.publicationState === "current") ?? options.find(o => o.kind === "selection_final");
      const snapshot = selected ?? null;
      const rankings = snapshot ? db.query<Omit<Ranking, "eligible"> & { eligible: number }, [number, string, number]>(
        `SELECT r.team_id AS teamId, t.name, t.abbreviation, ts.membership, r.wins, r.losses, r.ties,
          r.rating, r.colley_rank AS colleyRank, r.adjusted_rank AS adjustedRank, r.eligible,
          r.eligibility_reason AS eligibilityReason, r.original_route AS originalRoute, r.final_category AS finalCategory
         FROM snapshot_rankings r JOIN teams t ON t.id=r.team_id
         JOIN team_seasons ts ON ts.season=? AND ts.team_id=r.team_id
         WHERE r.snapshot_key=? AND r.snapshot_revision=? ORDER BY r.colley_rank, r.team_id`
      ).all(year, snapshot.key, snapshot.revision) : [];
      const swaps = snapshot ? db.query<{ sequence: number; details_json: string }, [string, number]>(
        "SELECT sequence, details_json FROM selection_events WHERE snapshot_key=? AND snapshot_revision=? ORDER BY sequence"
      ).all(snapshot.key, snapshot.revision).map(row => {
        const event = JSON.parse(row.details_json) as { winnerTeamId: string; loserTeamId: string;
          supportingGameIds: string[]; winnerBefore: string; loserBefore: string };
        return { sequence: row.sequence, winner: event.winnerTeamId, loser: event.loserTeamId,
          supportingGameIds: event.supportingGameIds, winnerBefore: event.winnerBefore, loserBefore: event.loserBefore };
      }) : [];
      const sync = db.query<{ ended_at_utc: string }, []>("SELECT ended_at_utc FROM sync_runs WHERE state='success' ORDER BY ended_at_utc DESC LIMIT 1").get();
      return { year, state: seasonState(year, options, currentFootballSeason()), options, snapshot,
        rankings: rankings.map(row => ({ ...row, eligible: Boolean(row.eligible) })), swaps,
        issue: requestedWeek !== undefined && !selected ? "That snapshot key is not published for this season." :
          !snapshot ? "No published snapshot for this season. Backfill and rebuild snapshots before viewing rankings." : null,
        lastSync: sync?.ended_at_utc ?? null, pending };
    }).deferred();
  } catch {
    return empty("Unable to read published rankings. Check database migrations and access.");
  } finally { db.close(); }
}

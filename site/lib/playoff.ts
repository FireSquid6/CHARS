import { readPublished, type SnapshotArtifact } from "../../packages/chars-db/src/snapshots";
import { openDatabase } from "chars-db";
import { join } from "node:path";

export const START_SEASON = 1998;

export function currentFootballSeason(now: Date = new Date(), timezone = process.env.SYNC_TIMEZONE || "America/Chicago"): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: timezone, year: "numeric", month: "numeric" }).formatToParts(now);
  const year = Number(parts.find(part => part.type === "year")?.value);
  const month = Number(parts.find(part => part.type === "month")?.value);
  return month >= 7 ? year : year - 1;
}

export function supportedSeason(year: number, now = new Date()): boolean {
  return Number.isSafeInteger(year) && year >= START_SEASON && year <= currentFootballSeason(now);
}

export async function publishedSeason(year: number): Promise<{ snapshots: SnapshotArtifact[]; issue: string | null }> {
  try {
    const snapshots = await readPublished(join(process.env.CHARS_CACHE_PATH ?? ".cache", "snapshots"), year);
    if (snapshots.some(snapshot => snapshot.season !== year || !/^[a-zA-Z0-9_-]+$/.test(snapshot.key)) ||
      new Set(snapshots.map(snapshot => snapshot.key)).size !== snapshots.length) {
      return { snapshots: [], issue: "Published snapshot manifest is inconsistent. Rebuild this season." };
    }
    return { snapshots, issue: null };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { snapshots: [], issue: "No published snapshots yet. Configure DATABASE_PATH and CFBD_API_KEY, backfill this season, then run snapshots:rebuild." };
    }
    return { snapshots: [], issue: "Published snapshots could not be read. Inspect the cache and rebuild this season." };
  }
}

export function verifiedFinal(snapshot: SnapshotArtifact): boolean {
  return snapshot.kind === "selection_final" && snapshot.coverage.length === 0;
}

export function defaultSnapshot(snapshots: SnapshotArtifact[]): SnapshotArtifact | undefined {
  return [...snapshots].reverse().find(verifiedFinal) ?? snapshots.at(-1);
}

export type TeamIdentity = { teamName: string; abbreviation: string | null; conference: string | null };

export function teamIdentities(year: number): Record<string, TeamIdentity> {
  if (!process.env.DATABASE_PATH) return {};
  try {
    const db = openDatabase();
    try {
      const rows = db.sqlite.query<{ teamId: string; teamName: string; abbreviation: string | null; conference: string | null }, [number]>(`
        SELECT s.team_id AS teamId, t.team_name AS teamName, t.abbreviation AS abbreviation, c.name AS conference
        FROM seasons s JOIN teams t ON t.team_id = s.team_id
        LEFT JOIN conferences c ON c.conference_id = s.conference_id WHERE s.year = ?`).all(year);
      return Object.fromEntries(rows.map(({ teamId, ...identity }) => [teamId, identity]));
    } finally { db.close(); }
  } catch {
    return {};
  }
}

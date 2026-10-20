import type { Database } from "bun:sqlite";
import type { Game, PollEntry, PollRelease, TeamSeason } from "../../chars-algorithm/src/index";

interface TeamRow { team_id: string; classification: string; conference_id: string }
interface GameRow { game_id: number; home_team: string; away_team: string; year: number; week: number; start_date: number; home_score: number | null; away_score: number | null }
interface ReleaseRow { release_id: string; poll_id: string; year: number; week: number; released_at: number }
interface EntryRow { release_id: string; team_id: string; rank: number }

export interface SourceGameMetadata {
  providerSeasonType: string;
  applicationGameType: Game["applicationGameType"];
  classificationSource: string;
  status: Game["status"];
  /** True only when the source explicitly verifies completion; null scores are never complete. */
  completed: boolean;
  payloadHash: string;
}
export interface SeasonSource {
  season: number;
  teams: TeamSeason[];
  games: Game[];
  polls: { release: PollRelease; entries: PollEntry[] }[];
  coverage: string[];
  pollTiming?: Record<string, PollTimingEvidence>;
}

/** Independently reviewed publication evidence, never generated from the CFBD calendar bound. */
export interface PollTimingEvidence {
  reviewedBy: string;
  reviewedAtUtc: string;
  source: string;
  pollFingerprint: string;
  releasedAtUtc?: string;
  interval?: { earliestUtc: string; latestUtc: string };
}

/** A read-only typed projection of the existing schema. Never infers a final from a score of 0-0. */
function readSeasonRows(sqlite: Database, season: number, metadata: Readonly<Record<string, SourceGameMetadata>>): SeasonSource {
  if (!Number.isSafeInteger(season) || season < 1) throw new Error("Invalid season");
  const teams = sqlite.query<TeamRow, [number]>("SELECT team_id, classification, conference_id FROM seasons WHERE year = ? ORDER BY team_id").all(season);
  const rawGames = sqlite.query<GameRow, [number]>("SELECT game_id, home_team, away_team, year, week, start_date, home_score, away_score FROM games WHERE year = ? ORDER BY game_id").all(season);
  const rawReleases = sqlite.query<ReleaseRow, [number]>("SELECT release_id, poll_id, year, week, released_at FROM poll_releases WHERE year = ? ORDER BY released_at, release_id").all(season);
  const entries = sqlite.query<EntryRow, [number]>("SELECT e.release_id, e.team_id, e.rank FROM poll_entries e JOIN poll_releases p ON p.release_id = e.release_id WHERE p.year = ? ORDER BY e.rank, e.team_id").all(season);
  const coverage: string[] = [];
  if (!teams.length) coverage.push("missing season membership");
  if (!rawGames.length) coverage.push("missing season schedule");
  const mappedTeams: TeamSeason[] = teams.map(row => ({ season, teamId: row.team_id,
    membership: row.classification === "FBS" ? "fbs" : row.classification === "FCS" ? "fcs" : "other",
    conference: row.conference_id }));
  const teamIds = new Set(mappedTeams.map(team => team.teamId));
  const games: Game[] = rawGames.map(row => {
    if (!teamIds.has(row.home_team) || !teamIds.has(row.away_team)) throw new Error(`Missing season-scoped opponent for game ${row.game_id}`);
    const extra = metadata[String(row.game_id)];
    if (extra && (!(["regular", "ccg", "bowl", "playoff", "unknown"] as unknown[]).includes(extra.applicationGameType) ||
      !(["scheduled", "in_progress", "completed", "cancelled", "postponed"] as unknown[]).includes(extra.status) ||
      typeof extra.completed !== "boolean" || typeof extra.classificationSource !== "string" || !extra.classificationSource ||
      typeof extra.providerSeasonType !== "string" || typeof extra.payloadHash !== "string" ||
      (extra.status === "completed") !== extra.completed)) throw new Error(`Invalid source metadata for game ${row.game_id}`);
    const hasScores = row.home_score !== null && row.away_score !== null;
    if ((row.home_score === null) !== (row.away_score === null)) throw new Error(`Partial score for game ${row.game_id}`);
    if (!extra) coverage.push(`game ${row.game_id}: completion/classification unverified`);
    if (extra?.completed && !hasScores) throw new Error(`Completed game ${row.game_id} lacks scores`);
    if (extra?.applicationGameType === "unknown") coverage.push(`game ${row.game_id}: classification unknown`);
    return { id: String(row.game_id), providerGameId: String(row.game_id), season, week: row.week,
      homeTeamId: row.home_team, awayTeamId: row.away_team, kickoffUtc: new Date(row.start_date).toISOString(),
      homeScore: row.home_score, awayScore: row.away_score,
      status: extra?.completed && hasScores ? "completed" : extra?.status === "cancelled" || extra?.status === "postponed" ? extra.status : "scheduled",
      completed: !!extra?.completed && hasScores, providerSeasonType: extra?.providerSeasonType ?? "unknown",
      applicationGameType: extra?.applicationGameType ?? "regular", classificationSource: extra?.classificationSource ?? "legacy-regular-table-unverified",
      payloadHash: extra?.payloadHash ?? "legacy-unverified", resultRevision: 0 };
  });
  const polls = rawReleases.filter(row => row.poll_id.toLowerCase() === "ap" || row.poll_id.toLowerCase() === "cfp")
    .map(row => ({ release: { id: row.release_id, season, type: row.poll_id.toLowerCase() as "ap" | "cfp",
      gameWeek: row.week, releasedAtUtc: new Date(row.released_at).toISOString(), effectiveAtUtc: null,
      sourceHash: "legacy-unverified" }, entries: entries.filter(entry => entry.release_id === row.release_id)
      .map(entry => ({ releaseId: entry.release_id, teamId: entry.team_id, rank: entry.rank, points: null })) }));
  return { season, teams: mappedTeams, games, polls, coverage };
}

/** Keep all source tables on the same SQLite read transaction snapshot. */
export function readSeason(sqlite: Database, season: number, metadata: Readonly<Record<string, SourceGameMetadata>> = {}): SeasonSource {
  sqlite.exec("BEGIN");
  try {
    const result = readSeasonRows(sqlite, season, metadata);
    sqlite.exec("COMMIT");
    return result;
  } catch (error) {
    sqlite.exec("ROLLBACK");
    throw error;
  }
}

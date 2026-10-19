// Server-only: never import this module from client components.
import { Database, type SQLQueryBindings } from "bun:sqlite";
import { isAbsolute } from "node:path";
import type { Game, Season, Snapshot, Team, TeamSeason } from "chars-algorithm";

export interface DatabaseConfig {
  path: string;
  busyTimeoutMs?: number;
}

export function configFromEnv(env: Record<string, string | undefined> = process.env): DatabaseConfig {
  const path = env.DATABASE_PATH;
  if (!path) throw new Error("DATABASE_PATH must be set to an absolute persistent SQLite file path");
  const timeout = env.SQLITE_BUSY_TIMEOUT_MS === undefined ? 5000 : Number(env.SQLITE_BUSY_TIMEOUT_MS);
  return { path, busyTimeoutMs: timeout };
}

export function openDatabase(config: DatabaseConfig): Database {
  if (!isAbsolute(config.path) || config.path === "/") throw new Error("Database path must be an absolute file path");
  const timeout = config.busyTimeoutMs ?? 5000;
  if (!Number.isSafeInteger(timeout) || timeout < 0 || timeout > 60000) throw new Error("Invalid SQLite busy timeout");
  const db = new Database(config.path, { create: true, strict: true });
  try {
    db.exec(`PRAGMA busy_timeout = ${timeout}`);
    const deadline = Date.now() + timeout;
    for (;;) {
      try {
        db.exec("PRAGMA journal_mode = WAL");
        break;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "SQLITE_BUSY") || Date.now() >= deadline) throw error;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Math.min(25, deadline - Date.now()));
      }
    }
    db.exec("PRAGMA foreign_keys = ON");
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

export type Sqlite = Database;

export function transaction<T>(db: Database, work: () => T): T {
  return db.transaction(work)();
}

export interface PreparedRepository<Row, Params extends SQLQueryBindings[]> {
  get(...params: Params): Row | null;
  all(...params: Params): Row[];
}

export function prepareRows<Row, Params extends SQLQueryBindings[]>(db: Database, sql: string): PreparedRepository<Row, Params> {
  const statement = db.query<Row, Params>(sql);
  return {
    get: (...params) => statement.get(...params as Params extends any[] ? Params : [Params]),
    all: (...params) => statement.all(...params as Params extends any[] ? Params : [Params]),
  };
}

interface SeasonRow {
  year: number;
  state: Season["state"];
  selection_freeze_utc: string | null;
  calendar_policy_version: string;
  coverage_json: string;
}

interface TeamRow {
  id: string;
  provider_id: string | null;
  name: string;
  abbreviation: string | null;
}

export function createRepository(db: Database) {
  const seasons = prepareRows<SeasonRow, [number]>(db, "SELECT * FROM seasons WHERE year = ?");
  const teams = prepareRows<TeamRow, [string]>(db, "SELECT * FROM teams WHERE id = ?");
  const membership = prepareRows<TeamSeason, [number, string]>(db,
    "SELECT season, team_id AS teamId, membership, conference FROM team_seasons WHERE season = ? AND team_id = ?");
  const games = prepareRows<Game, [number]>(db,
    "SELECT id, provider_game_id AS providerGameId, season, week, home_team_id AS homeTeamId, away_team_id AS awayTeamId, kickoff_utc AS kickoffUtc, home_score AS homeScore, away_score AS awayScore, status, completed, provider_season_type AS providerSeasonType, application_game_type AS applicationGameType, classification_source AS classificationSource, payload_hash AS payloadHash, result_revision AS resultRevision FROM games WHERE season = ? ORDER BY kickoff_utc, id");
  const snapshots = prepareRows<Snapshot, [number]>(db,
    "SELECT snapshot_key AS key, season, revision, input_hash AS inputHash, policy_version AS policyVersion, model_version AS modelVersion, calendar_policy_version AS calendarPolicyVersion, kind, week, game_cutoff_utc AS gameCutoffUtc, poll_cutoff_utc AS pollCutoffUtc, poll_release_id AS pollReleaseId, coverage_json AS coverage, published_at_utc AS publishedAtUtc FROM snapshots AS s WHERE season = ? AND published_at_utc IS NOT NULL AND NOT EXISTS (SELECT 1 FROM snapshots AS newer WHERE newer.snapshot_key = s.snapshot_key AND newer.revision > s.revision AND newer.published_at_utc IS NOT NULL) ORDER BY game_cutoff_utc DESC, revision DESC");
  const upsertSeason = db.query<void, [number, string, string | null, string, string]>(
    "INSERT INTO seasons (year, state, selection_freeze_utc, calendar_policy_version, coverage_json) VALUES (?, ?, ?, ?, ?) ON CONFLICT(year) DO UPDATE SET state=excluded.state, selection_freeze_utc=excluded.selection_freeze_utc, calendar_policy_version=excluded.calendar_policy_version, coverage_json=excluded.coverage_json");
  const upsertTeam = db.query<void, [string, string | null, string, string | null]>(
    "INSERT INTO teams (id, provider_id, name, abbreviation) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET provider_id=excluded.provider_id, name=excluded.name, abbreviation=excluded.abbreviation");
  const upsertMembership = db.query<void, [number, string, string, string | null]>(
    "INSERT INTO team_seasons (season, team_id, membership, conference) VALUES (?, ?, ?, ?) ON CONFLICT(season, team_id) DO UPDATE SET membership=excluded.membership, conference=excluded.conference");
  return {
    transaction: <T>(work: () => T) => transaction(db, work),
    season: (year: number): Season | null => {
      const row = seasons.get(year);
      return row && { year: row.year, state: row.state, selectionFreezeUtc: row.selection_freeze_utc,
        calendarPolicyVersion: row.calendar_policy_version, coverage: row.coverage_json };
    },
    team: (id: string): Team | null => {
      const row = teams.get(id);
      return row && { id: row.id, providerId: row.provider_id, name: row.name, abbreviation: row.abbreviation };
    },
    teamSeason: (year: number, id: string) => membership.get(year, id),
    gamesForSeason: (year: number) => games.all(year).map(game => ({ ...game, completed: Boolean(game.completed) })),
    publishedSnapshots: (year: number) => snapshots.all(year),
    saveSeason: (season: Season) => upsertSeason.run(season.year, season.state, season.selectionFreezeUtc, season.calendarPolicyVersion, season.coverage),
    saveTeam: (team: Team) => upsertTeam.run(team.id, team.providerId, team.name, team.abbreviation),
    saveTeamSeason: (teamSeason: TeamSeason) => upsertMembership.run(teamSeason.season, teamSeason.teamId, teamSeason.membership, teamSeason.conference),
  };
}

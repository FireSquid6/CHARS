import { afterEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CALENDAR_POLICY_VERSION } from "chars-algorithm";
import { configFromEnv, createRepository, openDatabase, transaction } from "../src/index";
import { migrate } from "../src/migrate";

const directories: string[] = [];
afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function temporaryPath(): string {
  const directory = mkdtempSync(join(tmpdir(), "chars-db-"));
  directories.push(directory);
  return join(directory, "test.sqlite");
}

async function setup() {
  const path = temporaryPath();
  const db = openDatabase({ path, busyTimeoutMs: 1377 });
  await migrate(db);
  return { db, path };
}

test("requires an absolute path and safe timeout without credentials", () => {
  expect(() => configFromEnv({})).toThrow("DATABASE_PATH");
  expect(() => openDatabase({ path: "relative.sqlite" })).toThrow("absolute");
  expect(() => openDatabase({ path: temporaryPath(), busyTimeoutMs: -1 })).toThrow("timeout");
});

test("migrations are repeatable and every inventory table exists", async () => {
  const { db } = await setup();
  try {
    await migrate(db);
    expect(db.query("SELECT version FROM schema_migrations").all()).toHaveLength(1);
    const names = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name);
    for (const name of ["seasons", "teams", "team_aliases", "team_seasons", "games", "game_revisions", "ingestion_payloads", "poll_releases", "poll_entries", "snapshots", "snapshot_games", "snapshot_rankings", "selection_events", "bracket_slots", "scenario_jobs", "scenario_statuses", "scenario_witnesses", "sync_runs", "job_leases", "schema_migrations"]) {
      expect(names).toContain(name);
    }
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { db.close(); }
});

test("WAL, foreign keys, busy timeout, checks, and typed repository access", async () => {
  const { db, path } = await setup();
  try {
    expect(db.query<{ journal_mode: string }, []>("PRAGMA journal_mode").get()?.journal_mode).toBe("wal");
    expect(db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()?.foreign_keys).toBe(1);
    expect(db.query<{ timeout: number }, []>("PRAGMA busy_timeout").get()?.timeout).toBe(1377);
    const repo = createRepository(db);
    repo.saveSeason({ year: 2026, state: "current", selectionFreezeUtc: null, calendarPolicyVersion: CALENDAR_POLICY_VERSION, coverage: "{}" });
    repo.saveTeam({ id: "a", providerId: "1", name: "Alpha", abbreviation: "A" });
    repo.saveTeam({ id: "b", providerId: "2", name: "Beta", abbreviation: null });
    repo.saveTeamSeason({ season: 2026, teamId: "a", membership: "fbs", conference: null });
    expect(repo.season(2026)?.state).toBe("current");
    expect(repo.teamSeason(2026, "a")?.membership).toBe("fbs");
    expect(() => repo.saveTeamSeason({ season: 2026, teamId: "absent", membership: "fbs", conference: null })).toThrow();
    const insert = db.query("INSERT INTO games (id, provider_game_id, season, home_team_id, away_team_id, status, completed, provider_season_type, application_game_type, classification_source, first_seen_utc, last_seen_utc, payload_hash) VALUES (?, ?, 2026, ?, ?, 'scheduled', 0, 'regular', 'regular', 'test', '2026-01-01', '2026-01-01', 'hash')");
    expect(() => insert.run("same", "same", "a", "a")).toThrow();
    insert.run("game", "provider-game", "a", "b");
    expect(repo.gamesForSeason(2026)[0]?.completed).toBe(false);
    expect(() => db.query("UPDATE games SET completed = 1 WHERE id = 'game'").run()).toThrow();
    const second = new Database(path);
    try { expect(second.query<{ count: number }, []>("SELECT count(*) AS count FROM games").get()?.count).toBe(1); }
    finally { second.close(); }
  } finally { db.close(); }
});

test("transaction rolls back all writes on error", async () => {
  const { db } = await setup();
  try {
    const repo = createRepository(db);
    expect(() => transaction(db, () => {
      repo.saveSeason({ year: 2025, state: "final", selectionFreezeUtc: null, calendarPolicyVersion: CALENDAR_POLICY_VERSION, coverage: "{}" });
      repo.saveTeamSeason({ season: 2025, teamId: "missing", membership: "fbs", conference: null });
    })).toThrow();
    expect(repo.season(2025)).toBeNull();
  } finally { db.close(); }
});

test("alias identity, poll ties, snapshot revision links, and atomic publication", async () => {
  const { db } = await setup();
  try {
    const repo = createRepository(db);
    repo.saveSeason({ year: 2000, state: "final", selectionFreezeUtc: null, calendarPolicyVersion: CALENDAR_POLICY_VERSION, coverage: "{}" });
    repo.saveTeam({ id: "a", providerId: "1", name: "Alpha", abbreviation: null });
    repo.saveTeam({ id: "b", providerId: "2", name: "Beta", abbreviation: null });
    db.query("INSERT INTO team_aliases VALUES ('cfbd', 'Alpha', 'a')").run();
    expect(() => db.query("INSERT INTO team_aliases VALUES ('cfbd', 'Alpha', 'b')").run()).toThrow();
    db.query("INSERT INTO poll_releases (id, season, poll_type, source_hash) VALUES ('poll', 2000, 'ap', 'hash')").run();
    db.query("INSERT INTO poll_entries (release_id, team_id, rank) VALUES ('poll', 'a', 1), ('poll', 'b', 1)").run();
    expect(db.query("SELECT * FROM poll_entries WHERE rank = 1").all()).toHaveLength(2);
    expect(() => db.query("INSERT INTO snapshot_games VALUES ('missing', 1, 'missing', 1)").run()).toThrow();
    const publish = () => transaction(db, () => {
      db.query("INSERT INTO snapshots (snapshot_key, revision, season, kind, game_cutoff_utc, input_hash, policy_version, model_version, calendar_policy_version, coverage_json, published_at_utc) VALUES ('final', 1, 2000, 'selection_final', '2000-12-01', 'hash', 'policy', 'model', 'calendar', '{}', '2000-12-02')").run();
      db.query("INSERT INTO snapshot_rankings (snapshot_key, snapshot_revision, team_id, wins, losses, ties, rating, residual, precision_method, colley_rank, eligible, original_route, final_category) VALUES ('final', 1, 'absent', 0, 0, 0, 0.5, 0, 'float', 1, 0, 'outside', 'outside')").run();
    });
    expect(publish).toThrow();
    expect(repo.publishedSnapshots(2000)).toEqual([]);
  } finally { db.close(); }
});

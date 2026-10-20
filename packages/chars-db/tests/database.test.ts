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
    expect(db.query("SELECT version FROM schema_migrations").all()).toHaveLength(10);
    const names = db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(row => row.name);
    for (const name of ["seasons", "teams", "team_aliases", "team_seasons", "games", "game_revisions", "ingestion_payloads", "poll_releases", "poll_entries", "snapshots", "snapshot_games", "snapshot_rankings", "selection_events", "bracket_slots", "scenario_jobs", "scenario_job_secrets", "scenario_statuses", "scenario_witnesses", "sync_runs", "job_leases", "schema_migrations"]) {
      expect(names).toContain(name);
    }
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { db.close(); }
});

test("upgrades a populated, previously migrated 001 database without losing FK-linked data", async () => {
  const path = temporaryPath();
  const original = openDatabase({ path });
  try {
    original.exec(await Bun.file(join(import.meta.dir, "../migrations/001_initial.sql")).text());
    original.exec("CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at_utc TEXT NOT NULL)");
    original.query("INSERT INTO schema_migrations VALUES ('001_initial.sql', '2026-01-01')").run();
    const repo = createRepository(original);
    repo.saveSeason({ year: 2026, state: "current", selectionFreezeUtc: null, calendarPolicyVersion: CALENDAR_POLICY_VERSION, coverage: "{}" });
    repo.saveSeason({ year: 2025, state: "final", selectionFreezeUtc: null, calendarPolicyVersion: CALENDAR_POLICY_VERSION, coverage: "{}" });
    repo.saveTeam({ id: "a", providerId: "1", name: "A", abbreviation: null });
    repo.saveTeam({ id: "b", providerId: "2", name: "B", abbreviation: null });
    original.query("INSERT INTO ingestion_payloads VALUES ('payload', 'cfbd', '/games', 2026, 'same', '2026-01-01', '{}')").run();
    original.query("INSERT INTO games (id, provider_game_id, season, home_team_id, away_team_id, status, completed, provider_season_type, application_game_type, classification_source, first_seen_utc, last_seen_utc, payload_hash) VALUES ('game', 'provider-game', 2026, 'a', 'b', 'scheduled', 0, 'regular', 'regular', 'test', '2026-01-01', '2026-01-01', 'same')").run();
    original.query("INSERT INTO game_revisions (game_id, revision, payload_id, payload_hash, observed_at_utc, normalized_json) VALUES ('game', 1, 'payload', 'same', '2026-01-01', '{}')").run();
    original.query("INSERT INTO poll_releases (id, season, poll_type, source_hash, payload_id) VALUES ('poll', 2026, 'ap', 'same', 'payload')").run();
    original.query("INSERT INTO poll_entries (release_id, team_id, rank) VALUES ('poll', 'a', 1)").run();
    original.query("INSERT INTO snapshots (snapshot_key, revision, season, kind, game_cutoff_utc, poll_release_id, input_hash, policy_version, model_version, calendar_policy_version, coverage_json, published_at_utc) VALUES ('week', 1, 2026, 'week_final', '2026-09-01', 'poll', 'same', 'policy', 'model', 'calendar', '{}', '2026-09-02')").run();
    original.query("INSERT INTO snapshot_games VALUES ('week', 1, 'game', 1)").run();
    original.query("INSERT INTO scenario_jobs (id, snapshot_key, snapshot_revision, poll_model_version, solver_version, input_hash, state, created_at_utc, updated_at_utc) VALUES ('job', 'week', 1, 'all', 'v1', 'same', 'pending', '2026-09-02', '2026-09-02')").run();
    original.query("INSERT INTO scenario_statuses (job_id, team_id, state, assumptions_json) VALUES ('job', 'a', 'pending', '[]')").run();
    original.query("INSERT INTO scenario_witnesses VALUES ('job', 'a', 'qualifying', '{\"path\":\"old\"}')").run();
    expect(original.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { original.close(); }
  const upgraded = openDatabase({ path });
  try {
    await migrate(upgraded);
    await migrate(upgraded);
    expect(upgraded.query<{ version: string }, []>("SELECT version FROM schema_migrations ORDER BY version").all().map(row => row.version))
      .toEqual(["001_initial.sql", "002_observations_and_snapshot_integrity.sql", "003_calendar_and_provenance.sql", "004_input_revisions_and_gaps.sql", "005_snapshot_publication.sql", "006_input_generation_and_publication_state.sql", "007_scenario_work.sql", "008_sync_queue.sql", "009_sync_work_plans.sql", "010_scenario_checkpoint_keys.sql"]);
    expect(upgraded.query("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(upgraded.query<{ payload_id: string }, []>("SELECT payload_id FROM game_revisions WHERE game_id = 'game'").get()?.payload_id).toBe("payload");
    expect(upgraded.query<{ payload_id: string }, []>("SELECT payload_id FROM poll_releases WHERE id = 'poll'").get()?.payload_id).toBe("payload");
    expect(upgraded.query("SELECT * FROM snapshot_games").all()).toHaveLength(1);
    expect(upgraded.query<{ sequence: number }, []>("SELECT sequence FROM scenario_witnesses").get()?.sequence).toBe(1);
    upgraded.query("INSERT INTO ingestion_payloads VALUES ('again', 'cfbd', '/games', 2026, 'same', '2026-01-02', '{}')").run();
    upgraded.query("INSERT INTO scenario_witnesses VALUES ('job', 'a', 'qualifying', 2, '{}')").run();
    expect(upgraded.query("SELECT * FROM ingestion_payloads").all()).toHaveLength(2);
    expect(upgraded.query("SELECT * FROM scenario_witnesses").all()).toHaveLength(2);
    upgraded.query("INSERT INTO poll_releases (id, season, poll_type, source_hash) VALUES ('old-poll', 2025, 'ap', 'hash')").run();
    expect(() => upgraded.query("UPDATE snapshots SET poll_release_id = 'old-poll' WHERE snapshot_key = 'week'").run()).toThrow("snapshot poll season mismatch");
    expect(upgraded.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { upgraded.close(); }
});

test("invalid legacy snapshot links abort 002 atomically and restore FK enforcement", async () => {
  const db = openDatabase({ path: temporaryPath() });
  try {
    db.exec(await Bun.file(join(import.meta.dir, "../migrations/001_initial.sql")).text());
    db.exec("CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at_utc TEXT NOT NULL)");
    db.query("INSERT INTO schema_migrations VALUES ('001_initial.sql', '2026-01-01')").run();
    db.query("INSERT INTO seasons (year, state, calendar_policy_version) VALUES (2025, 'final', 'calendar'), (2026, 'final', 'calendar')").run();
    db.query("INSERT INTO poll_releases (id, season, poll_type, source_hash) VALUES ('old-poll', 2025, 'ap', 'hash')").run();
    db.query("INSERT INTO snapshots (snapshot_key, revision, season, kind, game_cutoff_utc, poll_release_id, input_hash, policy_version, model_version, calendar_policy_version, coverage_json) VALUES ('bad', 1, 2026, 'week_final', '2026-09-01', 'old-poll', 'hash', 'policy', 'model', 'calendar', '{}')").run();
    expect(db.query("SELECT s.snapshot_key FROM snapshots s JOIN poll_releases p ON p.id = s.poll_release_id WHERE p.season <> s.season").all()).toHaveLength(1);
    await expect(migrate(db)).rejects.toThrow("cross-season");
    expect(db.query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()?.foreign_keys).toBe(1);
    expect(db.query("SELECT * FROM schema_migrations").all()).toHaveLength(1);
    expect(db.query<{ poll_release_id: string }, []>("SELECT poll_release_id FROM snapshots WHERE snapshot_key = 'bad'").get()?.poll_release_id).toBe("old-poll");
    expect(db.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'ingestion_payload_lookup'").all()).toEqual([]);
  } finally { db.close(); }
});

test("two independent processes migrate the same new database without racing versions", async () => {
  const path = temporaryPath();
  const command = [process.execPath, join(import.meta.dir, "../src/migrate.ts")];
  const processes = Array.from({ length: 2 }, () => Bun.spawn(command, {
    env: { ...process.env, DATABASE_PATH: path }, stdout: "pipe", stderr: "pipe",
  }));
  const results = await Promise.all(processes.map(async process => ({
    code: await process.exited,
    stderr: await new Response(process.stderr).text(),
  })));
  for (const result of results) {
    if (result.code !== 0) throw new Error(`Concurrent migration exited ${result.code}: ${result.stderr}`);
  }
  const db = openDatabase({ path });
  try {
    expect(db.query("SELECT * FROM schema_migrations").all()).toHaveLength(10);
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

test("identical payloads remain separate observations across sources, dates, and seasons", async () => {
  const { db } = await setup();
  try {
    const insert = db.query("INSERT INTO ingestion_payloads (id, source, source_url, season, hash, observed_at_utc, raw_json) VALUES (?, 'cfbd', ?, NULL, 'same-hash', ?, '{}')");
    insert.run("first", "/games?year=2026", "2026-10-01T00:00:00Z");
    insert.run("second", "/games?year=2026", "2026-10-02T00:00:00Z");
    insert.run("third", "/games?year=2025", "2026-10-02T00:00:00Z");
    expect(db.query("SELECT id FROM ingestion_payloads WHERE source = 'cfbd' AND hash = 'same-hash'").all()).toHaveLength(3);
  } finally { db.close(); }
});

test("004 upgrades historical duplicate poll weeks without losing either release", async () => {
  const db = openDatabase({ path: temporaryPath() });
  try {
    db.exec("PRAGMA foreign_keys=OFF");
    for (const file of ["001_initial.sql", "002_observations_and_snapshot_integrity.sql", "003_calendar_and_provenance.sql"]) {
      db.exec(await Bun.file(join(import.meta.dir, "../migrations", file)).text());
    }
    db.exec("PRAGMA foreign_keys=ON");
    db.exec("CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at_utc TEXT NOT NULL)");
    for (const file of ["001_initial.sql", "002_observations_and_snapshot_integrity.sql", "003_calendar_and_provenance.sql"]) {
      db.query("INSERT INTO schema_migrations VALUES (?, '2026-10-01T00:00:00Z')").run(file);
    }
    db.query("INSERT INTO seasons (year, state, calendar_policy_version) VALUES (1998, 'incomplete', 'v1')").run();
    db.query(`INSERT INTO ingestion_payloads VALUES
      ('old', 'cfbd:rankings', '/rankings', 1998, 'oldhash', '2026-10-01T00:00:00Z', '{}'),
      ('new', 'cfbd:rankings', '/rankings', 1998, 'newhash', '2026-10-02T00:00:00Z', '{}')`).run();
    db.query(`INSERT INTO poll_releases (id, season, poll_type, game_week, source_hash, payload_id) VALUES
      ('old-poll', 1998, 'ap', 2, 'oldhash', 'old'), ('new-poll', 1998, 'ap', 2, 'newhash', 'new')`).run();
    await migrate(db);
    expect(db.query<{ id: string; is_current: number }, []>("SELECT id, is_current FROM poll_releases ORDER BY id").all())
      .toEqual([{ id: "new-poll", is_current: 1 }, { id: "old-poll", is_current: 0 }]);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { db.close(); }
});

test("005 upgrades mixed published and unpublished revisions using highest published revision, not latest timestamp", async () => {
  const db = openDatabase({ path: temporaryPath() });
  try {
    db.exec("PRAGMA foreign_keys=OFF");
    const files = ["001_initial.sql", "002_observations_and_snapshot_integrity.sql",
      "003_calendar_and_provenance.sql", "004_input_revisions_and_gaps.sql"];
    for (const file of files) db.exec(await Bun.file(join(import.meta.dir, "../migrations", file)).text());
    db.exec("PRAGMA foreign_keys=ON");
    db.exec("CREATE TABLE schema_migrations (version TEXT PRIMARY KEY, applied_at_utc TEXT NOT NULL)");
    for (const file of files) db.query("INSERT INTO schema_migrations VALUES (?, '2026-10-01T00:00:00Z')").run(file);
    db.query("INSERT INTO seasons (year, state, calendar_policy_version) VALUES (2020, 'final', 'calendar')").run();
    const insert = db.query(`INSERT INTO snapshots (snapshot_key,revision,season,kind,game_cutoff_utc,
      input_hash,policy_version,model_version,calendar_policy_version,coverage_json,published_at_utc)
      VALUES (?,?,2020,'week_final','2020-09-01','hash','policy','model','calendar','{}',?)`);
    insert.run("week", 1, "2020-09-09");
    insert.run("week", 2, null);
    insert.run("week", 3, "2020-09-08");
    insert.run("only-unpublished", 1, null);
    await migrate(db);
    expect(db.query<{ snapshot_key: string; revision: number; published_at_utc: string; state: string }, []>(
      "SELECT snapshot_key,revision,published_at_utc,state FROM snapshot_publications").all())
      .toEqual([{ snapshot_key: "week", revision: 3, published_at_utc: "2020-09-08", state: "current" }]);
    expect(db.query<{ generation: number }, []>("SELECT generation FROM season_input_generations WHERE season=2020").get()?.generation).toBe(1);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { db.close(); }
});

test("publishedSnapshots returns only the newest published revision per key", async () => {
  const { db } = await setup();
  try {
    const repo = createRepository(db);
    repo.saveSeason({ year: 2026, state: "current", selectionFreezeUtc: null, calendarPolicyVersion: CALENDAR_POLICY_VERSION, coverage: "{}" });
    const insert = db.query("INSERT INTO snapshots (snapshot_key, revision, season, kind, game_cutoff_utc, input_hash, policy_version, model_version, calendar_policy_version, coverage_json, published_at_utc) VALUES (?, ?, 2026, 'week_final', ?, 'hash', 'policy', 'model', 'calendar', '{}', ?)");
    insert.run("week-1", 1, "2026-09-01", "2026-09-02");
    insert.run("week-1", 2, "2026-09-01", null);
    insert.run("week-2", 1, "2026-09-08", "2026-09-09");
    db.query("INSERT INTO snapshot_publications (snapshot_key, revision, published_at_utc) VALUES ('week-1', 1, '2026-09-02'), ('week-2', 1, '2026-09-09')").run();
    expect(repo.publishedSnapshots(2026).map(s => `${s.key}:${s.revision}`)).toEqual(["week-2:1", "week-1:1"]);
    db.query("UPDATE snapshots SET published_at_utc = '2026-09-10' WHERE snapshot_key = 'week-1' AND revision = 2").run();
    db.query("UPDATE snapshot_publications SET revision=2, published_at_utc='2026-09-10' WHERE snapshot_key='week-1'").run();
    expect(repo.publishedSnapshots(2026).map(s => `${s.key}:${s.revision}`)).toEqual(["week-2:1", "week-1:2"]);
    insert.run("week-1", 3, "2026-09-01", null);
    expect(repo.publishedSnapshots(2026).map(s => `${s.key}:${s.revision}`)).toEqual(["week-2:1", "week-1:2"]);
  } finally { db.close(); }
});

test("snapshot poll and included game must belong to its season, including updates", async () => {
  const { db } = await setup();
  try {
    const repo = createRepository(db);
    for (const year of [2025, 2026]) repo.saveSeason({ year, state: "final", selectionFreezeUtc: null, calendarPolicyVersion: CALENDAR_POLICY_VERSION, coverage: "{}" });
    repo.saveTeam({ id: "a", providerId: "1", name: "A", abbreviation: null });
    repo.saveTeam({ id: "b", providerId: "2", name: "B", abbreviation: null });
    db.query("INSERT INTO poll_releases (id, season, poll_type, source_hash) VALUES ('old-poll', 2025, 'ap', 'hash'), ('new-poll', 2026, 'ap', 'hash')").run();
    const snapshot = db.query("INSERT INTO snapshots (snapshot_key, revision, season, kind, game_cutoff_utc, poll_release_id, input_hash, policy_version, model_version, calendar_policy_version, coverage_json) VALUES ('week', 1, ?, 'week_final', '2026-09-01', ?, 'hash', 'policy', 'model', 'calendar', '{}')");
    expect(() => snapshot.run(2026, "old-poll")).toThrow("snapshot poll season mismatch");
    snapshot.run(2026, "new-poll");
    expect(() => db.query("UPDATE snapshots SET poll_release_id = 'old-poll' WHERE snapshot_key = 'week'").run()).toThrow("snapshot poll season mismatch");
    expect(() => db.query("UPDATE poll_releases SET season = 2025 WHERE id = 'new-poll'").run()).toThrow("snapshot poll season mismatch");
    const game = db.query("INSERT INTO games (id, provider_game_id, season, home_team_id, away_team_id, status, completed, provider_season_type, application_game_type, classification_source, first_seen_utc, last_seen_utc, payload_hash) VALUES (?, ?, ?, 'a', 'b', 'scheduled', 0, 'regular', 'regular', 'test', '2026-01-01', '2026-01-01', 'hash')");
    game.run("old-game", "old-game", 2025);
    game.run("new-game", "new-game", 2026);
    const revision = db.query("INSERT INTO game_revisions (game_id, revision, payload_hash, observed_at_utc, normalized_json) VALUES (?, 1, 'hash', '2026-01-01', '{}')");
    revision.run("old-game");
    revision.run("new-game");
    expect(() => db.query("INSERT INTO snapshot_games VALUES ('week', 1, 'old-game', 1)").run()).toThrow("snapshot game season mismatch");
    db.query("INSERT INTO snapshot_games VALUES ('week', 1, 'new-game', 1)").run();
    expect(() => db.query("UPDATE snapshot_games SET game_id = 'old-game' WHERE snapshot_key = 'week'").run()).toThrow("snapshot game season mismatch");
    expect(() => db.query("UPDATE games SET season = 2025 WHERE id = 'new-game'").run()).toThrow("snapshot game season mismatch");
    expect(() => db.query("UPDATE snapshots SET season = 2025 WHERE snapshot_key = 'week'").run()).toThrow();
  } finally { db.close(); }
});

test("stores alternative witnesses and hides incomplete publication from a second connection", async () => {
  const { db, path } = await setup();
  const reader = openDatabase({ path });
  try {
    const repo = createRepository(db);
    const visible = createRepository(reader);
    repo.saveSeason({ year: 2026, state: "current", selectionFreezeUtc: null, calendarPolicyVersion: CALENDAR_POLICY_VERSION, coverage: "{}" });
    repo.saveTeam({ id: "a", providerId: "1", name: "A", abbreviation: null });
    transaction(db, () => {
      db.query("INSERT INTO snapshots (snapshot_key, revision, season, kind, game_cutoff_utc, input_hash, policy_version, model_version, calendar_policy_version, coverage_json, published_at_utc) VALUES ('week', 1, 2026, 'week_final', '2026-09-01', 'hash', 'policy', 'model', 'calendar', '{}', '2026-09-02')").run();
      db.query("INSERT INTO snapshot_publications (snapshot_key, revision, published_at_utc) VALUES ('week', 1, '2026-09-02')").run();
      expect(visible.publishedSnapshots(2026)).toEqual([]);
      db.query("INSERT INTO scenario_jobs (id, snapshot_key, snapshot_revision, poll_model_version, solver_version, input_hash, state, created_at_utc, updated_at_utc) VALUES ('job', 'week', 1, 'all', 'v1', 'hash', 'pending', '2026-09-02', '2026-09-02')").run();
      db.query("INSERT INTO scenario_statuses (job_id, team_id, state, assumptions_json) VALUES ('job', 'a', 'pending', '[]')").run();
      const witness = db.query("INSERT INTO scenario_witnesses (job_id, team_id, kind, sequence, witness_json) VALUES ('job', 'a', 'qualifying', ?, ?)");
      witness.run(1, '{"path":"one"}');
      witness.run(2, '{"path":"two"}');
      expect(visible.publishedSnapshots(2026)).toEqual([]);
    });
    expect(visible.publishedSnapshots(2026).map(s => s.key)).toEqual(["week"]);
    expect(reader.query("SELECT * FROM scenario_witnesses WHERE kind = 'qualifying'").all()).toHaveLength(2);
  } finally { reader.close(); db.close(); }
});

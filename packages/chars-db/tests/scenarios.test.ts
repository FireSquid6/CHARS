import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../src/index";
import { migrate } from "../src/migrate";
import { solveSnapshot } from "../src/scenarios";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach(path => rmSync(path, { recursive: true, force: true })));

async function fixture() {
  const path = mkdtempSync("/tmp/opencode/chars-scenario-"); dirs.push(path);
  const db = openDatabase({ path: join(path, "test.db") }); await migrate(db);
  const coverage = JSON.stringify({ schedule: true, gameClassification: true, gameMembership: true,
    gameStatusKnown: true, selectionFreeze: true, fbsRoster: true });
  db.query(`INSERT INTO seasons (year,state,selection_freeze_utc,calendar_policy_version,coverage_json)
    VALUES (2026,'current','2026-12-01T00:00:00.000Z','pre-ccg-weekend-v1',?)`).run(coverage);
  db.query("INSERT INTO season_input_generations VALUES (2026,1)").run();
  db.query(`INSERT INTO season_ingestion_gaps (season,observed_at_utc,coverage_json,selection_freeze_utc)
    VALUES (2026,'2026-10-02T00:00:00.000Z',?,'2026-12-01T00:00:00.000Z')`).run(coverage);
  for (const id of ["A", "B", "FCS"]) {
    db.query("INSERT INTO teams (id,name) VALUES (?,?)").run(id, id);
    db.query("INSERT INTO team_seasons (season,team_id,membership) VALUES (2026,?,?)")
      .run(id, id === "FCS" ? "fcs" : "fbs");
  }
  const game = (id: string, home: string, away: string, future: boolean) => {
    db.query(`INSERT INTO games (id,provider_game_id,season,week,home_team_id,away_team_id,
      kickoff_utc,home_score,away_score,status,completed,provider_season_type,
      application_game_type,classification_source,first_seen_utc,last_seen_utc,payload_hash)
      VALUES (?,?,2026,1,?,?,?, ?,?, ?,?,'regular','regular','test',?,?,?)`).run(
      id, id, home, away, future ? "2026-11-01T12:00:00.000Z" : "2026-09-01T12:00:00.000Z",
      future ? null : 1, future ? null : 0, future ? "scheduled" : "completed", Number(!future),
      "2026-10-01T00:00:00.000Z", "2026-10-01T00:00:00.000Z", id);
    db.query(`INSERT INTO game_revisions (game_id,revision,payload_hash,observed_at_utc,normalized_json)
      VALUES (?,1,?,'2026-10-01T00:00:00.000Z','{}')`).run(id, id);
  };
  game("a1", "A", "FCS", false); game("a2", "A", "FCS", false);
  game("b1", "B", "FCS", false); game("b2", "B", "FCS", false);
  game("future", "A", "B", true);
  db.query(`INSERT INTO snapshots (snapshot_key,revision,season,week,kind,game_cutoff_utc,
    input_hash,policy_version,model_version,calendar_policy_version,coverage_json)
    VALUES ('week',1,2026,1,'week_final','2026-10-01T00:00:00.000Z','snapshot-input',
      'selection-v1','colley-fbs-only-v1','pre-ccg-weekend-v1','{"complete":true}')`).run();
  db.query(`INSERT INTO snapshot_publications (snapshot_key,revision,published_at_utc,state)
    VALUES ('week',1,'2026-10-02T00:00:00.000Z','current')`).run();
  for (const id of ["a1", "a2", "b1", "b2"])
    db.query("INSERT INTO snapshot_games VALUES ('week',1,?,1)").run(id);
  return { db, game };
}

test("bounded retries restart; only exhaustive run publishes terminal labels atomically", async () => {
  const { db } = await fixture();
  try {
    const budget = { maxCompletions: 1, maxRuntimeMs: 10000, maxTrackedPollPaths: 100 };
    const first = solveSnapshot(db, "week", budget);
    expect(first.state).toBe("pending");
    expect(first.evaluated).toBe(1);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM scenario_statuses WHERE state='proved'").get()?.n).toBe(0);
    const second = solveSnapshot(db, "week", budget);
    expect(second.jobId).toBe(first.jobId);
    expect(second.state).toBe("pending");
    expect(second.evaluated).toBe(1);
    const exhaustive = solveSnapshot(db, "week", { ...budget, maxCompletions: 2 });
    expect(exhaustive.state).toBe("proved");
    expect(exhaustive.evaluated).toBe(2);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM scenario_witnesses").get()?.n).toBeGreaterThan(0);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM scenario_statuses WHERE state='proved'").get()?.n).toBe(2);
    const proof = db.query<{ proof_metadata_json: string }, []>(
      "SELECT proof_metadata_json FROM scenario_statuses WHERE team_id='A'").get();
    expect(JSON.parse(proof!.proof_metadata_json).evaluatedCompletions).toBe(2);
  } finally { db.close(); }
});

test("memory interruption and smaller budgets never carry partial-leaf witnesses into proof", async () => {
  const { db } = await fixture();
  try {
    const stopped = solveSnapshot(db, "week", { maxCompletions: 2, maxRuntimeMs: 10000,
      maxTrackedPollPaths: 1 });
    expect(stopped.state).toBe("pending");
    expect(stopped.evaluated).toBe(1);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM scenario_statuses WHERE state='proved'").get()?.n).toBe(0);
    const retry = solveSnapshot(db, "week", { maxCompletions: 1, maxRuntimeMs: 10000,
      maxTrackedPollPaths: 2 });
    expect(retry.state).toBe("pending");
    expect(retry.evaluated).toBe(1);
    const done = solveSnapshot(db, "week", { maxCompletions: 2, maxRuntimeMs: 10000,
      maxTrackedPollPaths: 2 });
    expect(done.state).toBe("proved");
    expect(done.evaluated).toBe(2);
  } finally { db.close(); }
});

test("tampered persisted cursor is rejected; failed run releases its lease", async () => {
  const { db } = await fixture();
  try {
    const budget = { maxCompletions: 1, maxRuntimeMs: 10000, maxTrackedPollPaths: 100 };
    const first = solveSnapshot(db, "week", budget);
    db.query("UPDATE scenario_jobs SET checkpoint_json=? WHERE id=?")
      .run(JSON.stringify({ mode: "restart-only", lastEvaluated: 1, nextCompletion: 999 }), first.jobId);
    expect(() => solveSnapshot(db, "week", budget)).toThrow(/Unverified scenario checkpoint/);
    expect(db.query<{ lease_owner: string | null; state: string }, [string]>(
      "SELECT lease_owner,state FROM scenario_jobs WHERE id=?").get(first.jobId))
      .toMatchObject({ lease_owner: null, state: "pending" });
    db.query("UPDATE scenario_jobs SET checkpoint_json=? WHERE id=?")
      .run(JSON.stringify({ mode: "restart-only", lastEvaluated: 1 }), first.jobId);
    expect(() => solveSnapshot(db, "week", budget, () => { throw new Error("publication fault"); }))
      .toThrow("publication fault");
    expect(db.query<{ lease_owner: string | null; state: string }, [string]>(
      "SELECT lease_owner,state FROM scenario_jobs WHERE id=?").get(first.jobId))
      .toMatchObject({ lease_owner: null, state: "pending" });
    expect(solveSnapshot(db, "week", { ...budget, maxCompletions: 2 }).state).toBe("proved");
  } finally { db.close(); }
});

test("solver exceptions release leases and modern worker rejects historical ties", async () => {
  const { db } = await fixture();
  try {
    expect(() => solveSnapshot(db, "week", { maxCompletions: 0, maxRuntimeMs: 10000,
      maxTrackedPollPaths: 100 })).toThrow("Invalid scenario budget");
    expect(db.query<{ lease_owner: string | null }, []>("SELECT lease_owner FROM scenario_jobs").get()?.lease_owner)
      .toBeNull();
    expect(() => solveSnapshot(db, "week", { maxCompletions: 2, maxRuntimeMs: 10000,
      maxTrackedPollPaths: 100, allowHistoricalTies: true })).toThrow(/before 1996/);
    expect(solveSnapshot(db, "week", { maxCompletions: 2, maxRuntimeMs: 10000,
      maxTrackedPollPaths: 100 }).state).toBe("proved");
  } finally { db.close(); }
});

test("correction during publication rolls back; new generation has independent job identity", async () => {
  const { db } = await fixture();
  try {
    expect(() => solveSnapshot(db, "week", { maxCompletions: 1, maxRuntimeMs: 10000,
      maxTrackedPollPaths: 100 }, () => db.query("UPDATE season_input_generations SET generation=2 WHERE season=2026").run()))
      .toThrow(/stale generation/);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM scenario_statuses").get()?.n).toBe(0);
    const resumed = solveSnapshot(db, "week", { maxCompletions: 1, maxRuntimeMs: 10000,
      maxTrackedPollPaths: 100 });
    expect(resumed.state).toBe("pending");
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM scenario_jobs").get()?.n).toBe(2);
    db.query(`INSERT INTO snapshot_input_invalidations (snapshot_key,snapshot_revision,reason,input_id,observed_at_utc)
      VALUES ('week',1,'corrected','future','2026-10-03T00:00:00.000Z')`).run();
    expect(() => solveSnapshot(db, "week")).toThrow(/invalidated/);
  } finally { db.close(); }
});

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../src/index";
import { migrate } from "../src/migrate";
import { solveSnapshot } from "../src/scenarios";
import { claimScenarioWork, workScenarios } from "../src/scenario-worker";

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
  const fillers = Array.from({ length: 11 }, (_, i) => `C${String(i).padStart(2, "0")}`);
  for (const id of ["A", "B", ...fillers, "FCS"]) {
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
  for (const id of fillers) game(`f${id}`, id, "FCS", false);
  game("future", "A", "B", true);
  db.query(`INSERT INTO snapshots (snapshot_key,revision,season,week,kind,game_cutoff_utc,
    input_hash,policy_version,model_version,calendar_policy_version,coverage_json)
    VALUES ('week',1,2026,1,'week_final','2026-10-01T00:00:00.000Z','snapshot-input',
      'selection-v1','colley-fbs-only-v1','pre-ccg-weekend-v1','{"complete":true}')`).run();
  db.query(`INSERT INTO snapshot_publications (snapshot_key,revision,published_at_utc,state)
    VALUES ('week',1,'2026-10-02T00:00:00.000Z','current')`).run();
  for (const id of ["a1", "a2", "b1", "b2", ...fillers.map(id => `f${id}`)])
    db.query("INSERT INTO snapshot_games VALUES ('week',1,?,1)").run(id);
  return { db, game, path: join(path, "test.db") };
}

test("bounded retries resume certified frontier; only exhaustive run publishes terminal labels atomically", async () => {
  const { db } = await fixture();
  try {
    const budget = { maxCompletions: 1, maxRuntimeMs: 10000, maxTrackedPollPaths: 100 };
    const first = solveSnapshot(db, "week", budget);
    expect(first.state).toBe("pending");
    expect(first.evaluated).toBe(1);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM scenario_statuses WHERE state='proved'").get()?.n).toBe(0);
    const second = solveSnapshot(db, "week", budget);
    expect(second.jobId).toBe(first.jobId);
    expect(second.state).toBe("proved");
    expect(second.evaluated).toBe(1);
    const exhaustive = solveSnapshot(db, "week", { ...budget, maxCompletions: 2 });
    expect(exhaustive.state).toBe("proved");
    expect(exhaustive.evaluated).toBe(0);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM scenario_witnesses").get()?.n).toBeGreaterThan(0);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM scenario_statuses WHERE state='proved'").get()?.n).toBe(13);
    const proof = db.query<{ proof_metadata_json: string }, []>(
      "SELECT proof_metadata_json FROM scenario_statuses WHERE team_id='A'").get();
    expect(JSON.parse(proof!.proof_metadata_json).evaluatedCompletions).toBe(2);
  } finally { db.close(); }
});

test("two connections fence queue ownership; expired owner and scenario job cannot publish", async () => {
  const { db, path } = await fixture();
  const peer = openDatabase({ path });
  try {
    db.query("INSERT INTO scenario_work_queue (snapshot_key,snapshot_revision,state,updated_at_utc) VALUES ('week',1,'pending',?)")
      .run(new Date().toISOString());
    const first = claimScenarioWork(db)!;
    expect(claimScenarioWork(peer)).toBeNull();
    const budget = { maxCompletions: 2, maxRuntimeMs: 10000, maxTrackedPollPaths: 100 };
    expect(() => solveSnapshot(db, "week", budget, () => {
      peer.query("UPDATE scenario_work_queue SET expires_at_utc='2000-01-01T00:00:00.000Z' WHERE snapshot_key='week'").run();
    }, { owner: first.owner, revision: 1 })).toThrow(/queue lease lost or expired/);
    expect(db.query("SELECT * FROM scenario_statuses").all()).toHaveLength(0);
    const second = claimScenarioWork(peer)!;
    expect(second.owner).not.toBe(first.owner);
    expect(() => solveSnapshot(db, "week", budget, undefined, { owner: first.owner, revision: 1 }))
      .toThrow(/queue lease lost or expired/);
    expect(() => solveSnapshot(peer, "week", budget, () => {
      db.query("UPDATE scenario_jobs SET lease_expires_utc='2000-01-01T00:00:00.000Z'").run();
    }, { owner: second.owner, revision: 1 })).toThrow(/Scenario lease lost or expired/);
    expect(db.query("SELECT * FROM scenario_statuses").all()).toHaveLength(0);
    expect(solveSnapshot(peer, "week", budget, undefined, { owner: second.owner, revision: 1 }).state).toBe("proved");
  } finally { peer.close(); db.close(); }
});

test("budget pending is unproved and backs off; invocation cannot re-run same key", async () => {
  const { db } = await fixture();
  try {
    db.query("INSERT INTO scenario_work_queue (snapshot_key,snapshot_revision,state,updated_at_utc) VALUES ('week',1,'pending',?)")
      .run(new Date().toISOString());
    const budgeted: typeof solveSnapshot = (database, key, _budget, _hook, fence) =>
      solveSnapshot(database, key, { maxCompletions: 1, maxRuntimeMs: 10000, maxTrackedPollPaths: 100 }, undefined, fence);
    expect(workScenarios(db, 5, budgeted)).toEqual([{ key: "week", state: "pending" }]);
    const row = db.query<{ state: string; attempts: number; next_eligible_utc: string }, []>(
      "SELECT state,attempts,next_eligible_utc FROM scenario_work_queue").get()!;
    expect(row).toMatchObject({ state: "pending", attempts: 0 });
    expect(row.next_eligible_utc > new Date().toISOString()).toBe(true);
    expect(db.query("SELECT * FROM scenario_statuses WHERE state='proved'").all()).toHaveLength(0);
    expect(workScenarios(db, 5, budgeted)).toEqual([]);
  } finally { db.close(); }
});

test("expired third attempt is marked failure instead of stuck running; failures back off", async () => {
  const { db } = await fixture();
  try {
    db.query(`INSERT INTO scenario_work_queue
      (snapshot_key,snapshot_revision,state,updated_at_utc,attempts,owner,expires_at_utc)
      VALUES ('week',1,'running',?,3,'lost','2000-01-01T00:00:00.000Z')`).run(new Date().toISOString());
    expect(claimScenarioWork(db)).toBeNull();
    expect(db.query<{ state: string; error: string }, []>("SELECT state,error FROM scenario_work_queue").get())
      .toMatchObject({ state: "failure", error: "Scenario worker lease expired after maximum failed attempts" });
    db.query("UPDATE scenario_work_queue SET state='pending',attempts=2,next_eligible_utc=NULL").run();
    const fails: typeof solveSnapshot = () => { throw Error("transient"); };
    expect(workScenarios(db, 5, fails)).toEqual([{ key: "week", state: "failure" }]);
    expect(db.query<{ state: string; attempts: number }, []>("SELECT state,attempts FROM scenario_work_queue").get())
      .toMatchObject({ state: "failure", attempts: 3 });
  } finally { db.close(); }
});

test("memory interruption and smaller budgets never carry partial-leaf witnesses into proof", async () => {
  const { db } = await fixture();
  try {
    const stopped = solveSnapshot(db, "week", { maxCompletions: 2, maxRuntimeMs: 10000,
       maxTrackedPollPaths: 1 });
    expect(stopped.state).toBe("pending");
    expect(stopped.evaluated).toBe(0);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM scenario_statuses WHERE state='proved'").get()?.n).toBe(0);
    const retry = solveSnapshot(db, "week", { maxCompletions: 1, maxRuntimeMs: 10000,
       maxTrackedPollPaths: 13 });
    expect(retry.state).toBe("pending");
    expect(retry.evaluated).toBe(1);
    const done = solveSnapshot(db, "week", { maxCompletions: 2, maxRuntimeMs: 10000,
       maxTrackedPollPaths: 26 });
    expect(done.state).toBe("proved");
    expect(done.evaluated).toBe(1);
  } finally { db.close(); }
});

test("tampered persisted cursor is rejected; failed run releases its lease", async () => {
  const { db } = await fixture();
  try {
    const budget = { maxCompletions: 1, maxRuntimeMs: 10000, maxTrackedPollPaths: 100 };
    const first = solveSnapshot(db, "week", budget);
    const original = db.query<{ checkpoint_json: string }, [string]>(
      "SELECT checkpoint_json FROM scenario_jobs WHERE id=?").get(first.jobId)!.checkpoint_json;
    db.query("UPDATE scenario_jobs SET checkpoint_json=? WHERE id=?")
      .run(JSON.stringify({ payload: { evaluated: 1, gameIndex: "999" }, digest: "false" }), first.jobId);
    expect(() => solveSnapshot(db, "week", budget)).toThrow(/Unverified scenario checkpoint/);
    expect(db.query<{ lease_owner: string | null; state: string }, [string]>(
      "SELECT lease_owner,state FROM scenario_jobs WHERE id=?").get(first.jobId))
      .toMatchObject({ lease_owner: null, state: "pending" });
    // Restore a genuine checkpoint from the first indexed leaf.
    const firstPayload = JSON.parse(original);
    expect(firstPayload.payload.evaluated).toBe(1);
    db.query("UPDATE scenario_jobs SET checkpoint_json=? WHERE id=?").run(original, first.jobId);
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

test("poll dependence survives a stored subset cursor across two connections", async () => {
  const { db, path } = await fixture();
  const peer = openDatabase({ path });
  try {
    db.query("UPDATE games SET status='cancelled' WHERE id='future'").run();
    const budget = { maxCompletions: 2, maxRuntimeMs: 10000, maxTrackedPollPaths: 100 };
    const first = solveSnapshot(db, "week", budget);
    expect(first.state).toBe("pending");
    expect(first.evaluated).toBe(2);
    let current = first;
    for (let i = 0; i < 10 && current.state === "pending"; i++)
      current = solveSnapshot(peer, "week", budget);
    expect(current.state).toBe("proved");
    const row = peer.query<{ proof_metadata_json: string; label: string }, []>(
      "SELECT proof_metadata_json,label FROM scenario_statuses WHERE team_id='C10'").get()!;
    expect(row.label).toBe("needs_help");
    expect(JSON.parse(row.proof_metadata_json).pollDependent).toBe(true);
    expect(peer.query<{ evaluated_completions: number }, []>(
      "SELECT evaluated_completions FROM scenario_jobs").get()?.evaluated_completions).toBe(9);
  } finally { peer.close(); db.close(); }
});

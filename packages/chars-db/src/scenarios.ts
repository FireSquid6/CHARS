/** A bounded, resumable, single-writer scenario worker. Never called by request rendering. */
import { createHash, randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { computeScenarios, POLL_MODEL_VERSION, SOLVER_VERSION,
  type Game, type ScenarioCheckpoint, type ScenarioInput, type SnapshotIdentity, type TeamSeason } from "chars-algorithm";
import { configFromEnv, openDatabase, transaction } from "./index";
import { migrate } from "./migrate";

type SnapshotRow = { snapshot_key: string; revision: number; season: number; kind: string;
  game_cutoff_utc: string; input_hash: string; policy_version: string; model_version: string;
  calendar_policy_version: string; coverage_json: string; state: string };
type Job = { id: string; state: string; input_hash: string; input_generation: number;
  checkpoint_json: string | null; evaluated_completions: number;
  lease_owner: string | null; lease_expires_utc: string | null };
type Budget = { maxCompletions: number; maxRuntimeMs: number; maxTrackedPollPaths: number;
  allowHistoricalTies?: boolean };
export type QueueFence = { owner: string; revision: number };
const one = <T>(db: Database, sql: string, ...bindings: (number | string)[]) => db.query(sql).get(...bindings) as T | null;
const all = <T>(db: Database, sql: string, ...bindings: (number | string)[]) => db.query(sql).all(...bindings) as T[];
const sha = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export function solveSnapshot(db: Database, key: string, budget: Budget = {
  maxCompletions: 1000, maxRuntimeMs: 5000, maxTrackedPollPaths: 10000
}, beforePublish?: () => void, queueFence?: QueueFence) {
  const owner = randomUUID();
  const now = new Date().toISOString();
  const loaded = transaction(db, () => {
    const snapshot = one<SnapshotRow>(db, `SELECT s.*, p.state FROM snapshot_publications p JOIN snapshots s
      ON s.snapshot_key=p.snapshot_key AND s.revision=p.revision WHERE p.snapshot_key=?`, key);
    if (!snapshot) throw new Error(`No published snapshot: ${key}`);
    if (snapshot.kind === "selection_final") throw new Error("Final selection snapshot needs no scenarios");
    if (snapshot.state !== "current") throw new Error("Snapshot is not current");
    const generation = one<{ generation: number }>(db,
      "SELECT generation FROM season_input_generations WHERE season=?", snapshot.season)?.generation;
    if (!generation) throw new Error("No season input generation");
    const invalid = one(db, `SELECT 1 FROM snapshot_input_invalidations
      WHERE snapshot_key=? AND snapshot_revision=? LIMIT 1`, key, snapshot.revision);
    if (invalid) throw new Error("Snapshot inputs invalidated; rebuild first");
    const gap = one<{ coverage_json: string; selection_freeze_utc: string | null }>(db,
      `SELECT coverage_json, selection_freeze_utc FROM season_ingestion_gaps WHERE season=?
       ORDER BY observed_at_utc DESC, rowid DESC LIMIT 1`, snapshot.season);
    const freeze = gap?.selection_freeze_utc;
    if (!freeze || snapshot.game_cutoff_utc >= freeze) throw new Error("No valid pre-freeze selection window");
    const coverage = JSON.parse(gap.coverage_json) as Record<string, boolean>;
    const snapshotCoverage = JSON.parse(snapshot.coverage_json) as { complete?: boolean; reasons?: string[] };
    const required = ["schedule", "gameClassification", "gameMembership", "gameStatusKnown", "selectionFreeze", "fbsRoster"];
    const scheduleComplete = snapshotCoverage.complete === true && required.every(field => coverage[field] === true);
    const teams = all<TeamSeason>(db, `SELECT season, team_id AS teamId, membership, conference
      FROM team_seasons WHERE season=? ORDER BY team_id`, snapshot.season);
    const included = new Set(all<{ game_id: string; game_revision: number }>(db,
      "SELECT game_id, game_revision FROM snapshot_games WHERE snapshot_key=? AND snapshot_revision=?",
      key, snapshot.revision).map(row => `${row.game_id}:${row.game_revision}`));
    const raw = all<Omit<Game, "completed"> & { completed: number }>(db, `SELECT id, provider_game_id AS providerGameId, season, week,
      home_team_id AS homeTeamId, away_team_id AS awayTeamId, kickoff_utc AS kickoffUtc,
      home_score AS homeScore, away_score AS awayScore, status, completed,
      provider_season_type AS providerSeasonType, application_game_type AS applicationGameType,
      classification_source AS classificationSource, payload_hash AS payloadHash, result_revision AS resultRevision
      FROM games WHERE season=? ORDER BY id`, snapshot.season);
    let revisionGap = false;
    const games: Game[] = raw.map(row => {
      const frozen = included.has(`${row.id}:${row.resultRevision}`);
      if (!frozen && row.kickoffUtc && row.kickoffUtc <= snapshot.game_cutoff_utc &&
        row.applicationGameType === "regular" && row.status !== "cancelled") revisionGap = true;
      return frozen ? { ...row, completed: true } : row.completed && row.kickoffUtc &&
        row.kickoffUtc > snapshot.game_cutoff_utc && row.kickoffUtc < freeze &&
        row.applicationGameType === "regular" ? { ...row, completed: false, status: "scheduled",
          homeScore: null, awayScore: null } : { ...row, completed: Boolean(row.completed) };
    });
    if (revisionGap || [...included].some(ref => !raw.some(g => `${g.id}:${g.resultRevision}` === ref)))
      throw new Error("Snapshot game revisions do not match current inputs; rebuild first");
    const identity: SnapshotIdentity = { key, season: snapshot.season, revision: snapshot.revision,
      inputHash: snapshot.input_hash, policyVersion: snapshot.policy_version,
      modelVersion: snapshot.model_version, calendarPolicyVersion: snapshot.calendar_policy_version };
    const input: ScenarioInput = { snapshot: identity, season: snapshot.season, teams, games,
      gameCutoffUtc: snapshot.game_cutoff_utc, selectionFreezeUtc: freeze, scheduleComplete,
      allowHistoricalTies: budget.allowHistoricalTies === true };
    if (input.allowHistoricalTies && snapshot.season >= 1996)
      throw new Error("Historical ties are permitted only before 1996");
    const inputHash = sha([identity, generation, freeze, scheduleComplete, teams, games,
      input.allowHistoricalTies, POLL_MODEL_VERSION, SOLVER_VERSION]);
    return { input, generation, inputHash };
  });
  const { input, generation, inputHash } = loaded;
  const jobId = sha([key, input.snapshot.revision, POLL_MODEL_VERSION, SOLVER_VERSION, inputHash]);
  const guard = () => {
    if (queueFence) {
      const lease = one<{ owner: string | null; expires_at_utc: string | null; state: string }>(db,
        "SELECT owner,expires_at_utc,state FROM scenario_work_queue WHERE snapshot_key=? AND snapshot_revision=?",
        key, queueFence.revision);
      if (queueFence.revision !== input.snapshot.revision || lease?.state !== "running" ||
        lease.owner !== queueFence.owner || !lease.expires_at_utc || lease.expires_at_utc <= new Date().toISOString())
        throw new Error("Scenario queue lease lost or expired");
    }
    const pub = one<{ revision: number; state: string }>(db,
      "SELECT revision, state FROM snapshot_publications WHERE snapshot_key=?", key);
    const current = one<{ generation: number }>(db,
      "SELECT generation FROM season_input_generations WHERE season=?", input.season);
    if (pub?.revision !== input.snapshot.revision || pub.state !== "current" ||
      current?.generation !== generation || one(db, `SELECT 1 FROM snapshot_input_invalidations
      WHERE snapshot_key=? AND snapshot_revision=? LIMIT 1`, key, input.snapshot.revision))
      throw new Error("Scenario inputs changed; stale generation cancelled");
  };
  const job = transaction(db, () => {
    guard();
    let row = one<Job>(db, "SELECT * FROM scenario_jobs WHERE id=?", jobId);
    if (!row) {
      db.query(`INSERT INTO scenario_jobs (id,snapshot_key,snapshot_revision,poll_model_version,
        solver_version,input_hash,state,checkpoint_json,created_at_utc,updated_at_utc,input_generation,budget_json)
        VALUES (?,?,?,?,?,?,'pending',?, ?,?,?,?)`).run(jobId, key, input.snapshot.revision,
        POLL_MODEL_VERSION, SOLVER_VERSION, inputHash, null, now, now,
        generation, JSON.stringify(budget));
      row = one<Job>(db, "SELECT * FROM scenario_jobs WHERE id=?", jobId)!;
    }
    if (row.state === "proved" || row.state === "unsupported") return row;
    if (row.checkpoint_json !== null &&
      (JSON.parse(row.checkpoint_json) as ScenarioCheckpoint).payload?.evaluated !== row.evaluated_completions)
      throw new Error("Unverified scenario checkpoint; cannot resume or publish");
    if (row.checkpoint_json === null && row.evaluated_completions !== 0)
      throw new Error("Missing scenario checkpoint; cannot resume or publish");
    if (row.lease_expires_utc && row.lease_expires_utc > now && row.lease_owner !== owner)
      throw new Error("Scenario job already leased");
    db.query(`UPDATE scenario_jobs SET state='running',lease_owner=?,lease_expires_utc=?,
      updated_at_utc=?,budget_json=? WHERE id=?`).run(owner,
      new Date(Date.now() + Math.max(60000, budget.maxRuntimeMs + 30000)).toISOString(), now,
      JSON.stringify(budget), jobId);
    return row;
  });
  if (job.state === "proved" || job.state === "unsupported") return { jobId, state: job.state, evaluated: 0 };
  try {
    const result = computeScenarios({ ...input, ...budget,
      checkpoint: job.checkpoint_json ? JSON.parse(job.checkpoint_json) as ScenarioCheckpoint : undefined });
    beforePublish?.();
    transaction(db, () => {
      guard();
      const current = one<Job>(db, "SELECT * FROM scenario_jobs WHERE id=?", jobId);
      if (current?.lease_owner !== owner || !current.lease_expires_utc || current.lease_expires_utc <= new Date().toISOString())
        throw new Error("Scenario lease lost or expired");
      if (result.nextCompletion < job.evaluated_completions ||
        result.nextCompletion !== job.evaluated_completions + result.evaluatedCompletions)
        throw new Error("Scenario checkpoint did not advance monotonically");
      db.query("DELETE FROM scenario_witnesses WHERE job_id=?").run(jobId);
      db.query("DELETE FROM scenario_statuses WHERE job_id=?").run(jobId);
      for (const proof of result.proofs) {
        db.query(`INSERT INTO scenario_statuses (job_id,team_id,state,label,assumptions_json,proof_metadata_json,runtime_ms)
          VALUES (?,?,?,?,?,?,?) ON CONFLICT(job_id,team_id) DO UPDATE SET
          state=excluded.state,label=excluded.label,assumptions_json=excluded.assumptions_json,
          proof_metadata_json=excluded.proof_metadata_json,runtime_ms=excluded.runtime_ms`).run(jobId,
          proof.teamId, proof.state, proof.label, JSON.stringify(proof.assumptions), proof.proofMetadata, proof.runtimeMs);
        for (const witness of proof.witnesses) db.query(`INSERT INTO scenario_witnesses
          (job_id,team_id,kind,sequence,witness_json) VALUES (?,?,?,1,?)
          ON CONFLICT(job_id,team_id,kind,sequence) DO NOTHING`).run(jobId, proof.teamId, witness.kind, JSON.stringify(witness));
      }
      const state = result.complete ? result.proofs.some(p => p.state === "unsupported") ? "unsupported" : "proved" : "pending";
      db.query(`UPDATE scenario_jobs SET state=?, checkpoint_json=?,evaluated_completions=?,
        lease_owner=NULL,lease_expires_utc=NULL,updated_at_utc=? WHERE id=?`).run(state,
         result.checkpoint ? JSON.stringify(result.checkpoint) : null,
         result.nextCompletion, new Date().toISOString(), jobId);
    });
    return { jobId, state: result.complete ? result.proofs.some(p => p.state === "unsupported") ?
      "unsupported" : "proved" : "pending", evaluated: result.evaluatedCompletions,
      pendingReason: result.pendingReason };
  } finally {
    transaction(db, () => {
      db.query(`UPDATE scenario_jobs SET state='pending',lease_owner=NULL,lease_expires_utc=NULL,
        updated_at_utc=? WHERE id=? AND lease_owner=?`).run(new Date().toISOString(), jobId, owner);
    });
  }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if ((args.length !== 2 && args.length !== 3) || args[0] !== "--snapshot" || !args[1] ||
    (args.length === 3 && args[2] !== "--allow-historical-ties"))
    throw new Error("Usage: bun run scenarios:solve --snapshot KEY [--allow-historical-ties]");
  const db = openDatabase(configFromEnv());
  try {
    await migrate(db);
    const number = (key: string, fallback: number) => {
      const value = process.env[key] === undefined ? fallback : Number(process.env[key]);
      if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${key}`);
      return value;
    };
    console.log(JSON.stringify(solveSnapshot(db, args[1], {
      maxCompletions: number("SCENARIO_MAX_COMPLETIONS", 1000),
      maxRuntimeMs: number("SCENARIO_MAX_RUNTIME_MS", 5000),
      maxTrackedPollPaths: number("SCENARIO_MAX_TRACKED_POLL_PATHS", 10000),
      allowHistoricalTies: args[2] === "--allow-historical-ties"
    }), null, 2));
  } finally { db.close(); }
}

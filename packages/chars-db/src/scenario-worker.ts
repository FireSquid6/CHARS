/** Run independently of data:sync; jobs are revision-scoped and recover after an expired lease. */
import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { configFromEnv, openDatabase, transaction } from "./index";
import { migrate } from "./migrate";
import { solveSnapshot } from "./scenarios";

type Work = { snapshot_key: string; snapshot_revision: number; attempts: number };
const maxAttempts = 3;
export function claimScenarioWork(db: Database, now = new Date(), excluded: ReadonlySet<string> = new Set(), leaseMs = 15 * 60000) {
  const owner = randomUUID(), stamp = now.toISOString();
  const excludedKeys = [...excluded];
  const exclusion = excludedKeys.length ? `AND q.snapshot_key NOT IN (${excludedKeys.map(() => "?").join(",")})` : "";
  return transaction(db, () => {
    db.query(`UPDATE scenario_work_queue SET state='failure',owner=NULL,expires_at_utc=NULL,
      error='Scenario worker lease expired after maximum failed attempts',updated_at_utc=?
      WHERE state='running' AND expires_at_utc<=? AND attempts>=?`).run(stamp, stamp, maxAttempts);
    const row = db.query<Work, (string | number)[]>(`SELECT q.snapshot_key,q.snapshot_revision,q.attempts FROM scenario_work_queue q
      JOIN snapshot_publications p ON p.snapshot_key=q.snapshot_key AND p.revision=q.snapshot_revision AND p.state='current'
      WHERE (q.state='pending' OR (q.state='running' AND q.expires_at_utc<=?)) AND q.attempts<?
      AND (q.next_eligible_utc IS NULL OR q.next_eligible_utc<=?) ${exclusion}
      ORDER BY q.updated_at_utc,q.snapshot_key LIMIT 1`).get(stamp, maxAttempts, stamp, ...excludedKeys);
    if (!row) return null;
    db.query(`UPDATE scenario_work_queue SET state='running',owner=?,expires_at_utc=?,updated_at_utc=?,attempts=attempts+1,
      next_eligible_utc=NULL WHERE snapshot_key=? AND snapshot_revision=?`).run(owner, new Date(now.getTime() + leaseMs).toISOString(),
      stamp, row.snapshot_key, row.snapshot_revision);
    return { ...row, owner };
  });
}

export function workScenarios(db: Database, limit = 1, solve: typeof solveSnapshot = solveSnapshot) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid work limit");
  const results: Array<{ key: string; state: string }> = [];
  const seen = new Set<string>();
  for (let i = 0; i < limit; i++) {
    const job = claimScenarioWork(db, new Date(), seen);
    if (!job) break;
    const key = job.snapshot_key;
    seen.add(key);
    try {
      const runtime = Number(process.env.SCENARIO_MAX_RUNTIME_MS ?? 5000);
      if (!Number.isSafeInteger(runtime) || runtime < 1 || runtime > 60 * 60000) throw new Error("Invalid scenario runtime budget");
      // A bounded solve has a lease longer than its CPU budget; publication still verifies both live leases.
      const expires = new Date(Date.now() + Math.max(60000, runtime + 30000)).toISOString();
      db.query(`UPDATE scenario_work_queue SET expires_at_utc=? WHERE snapshot_key=? AND snapshot_revision=?
        AND owner=? AND expires_at_utc>?`).run(expires, key, job.snapshot_revision, job.owner, new Date().toISOString());
      const result = solve(db, key, { maxCompletions: Number(process.env.SCENARIO_MAX_COMPLETIONS ?? 1000),
        maxRuntimeMs: runtime, maxTrackedPollPaths: Number(process.env.SCENARIO_MAX_TRACKED_POLL_PATHS ?? 10000) },
        undefined, { owner: job.owner, revision: job.snapshot_revision });
      const state = result.state === "pending" ? "pending" : "done";
      transaction(db, () => {
        const updated = db.query(`UPDATE scenario_work_queue SET state=?,attempts=?,owner=NULL,expires_at_utc=NULL,
          next_eligible_utc=?,updated_at_utc=? WHERE snapshot_key=? AND snapshot_revision=? AND owner=?
          AND expires_at_utc>?`).run(state, state === "pending" ? 0 : job.attempts + 1,
          state === "pending" ? new Date(Date.now() + 60000).toISOString() : null,
          new Date().toISOString(), key, job.snapshot_revision, job.owner, new Date().toISOString());
        if (updated.changes !== 1) throw new Error("Scenario queue lease lost");
      });
      results.push({ key, state });
    } catch (error) {
      transaction(db, () => db.query(`UPDATE scenario_work_queue SET state=?,owner=NULL,expires_at_utc=NULL,
        error=?,next_eligible_utc=?,updated_at_utc=? WHERE snapshot_key=? AND snapshot_revision=? AND owner=?
        AND expires_at_utc>?`)
        .run(job.attempts + 1 >= maxAttempts ? "failure" : "pending", error instanceof Error ? error.message : "Worker failed",
          new Date(Date.now() + Math.min(60000, 1000 * 2 ** job.attempts)).toISOString(),
          new Date().toISOString(), key, job.snapshot_revision, job.owner, new Date().toISOString()));
      results.push({ key, state: "failure" });
    }
  }
  return results;
}

if (import.meta.main) {
  const db = openDatabase(configFromEnv());
  try { await migrate(db); console.log(JSON.stringify(workScenarios(db, Number(process.argv[2] ?? "1")))); }
  finally { db.close(); }
}

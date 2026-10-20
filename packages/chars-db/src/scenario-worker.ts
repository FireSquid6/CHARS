/** Run independently of data:sync; jobs are revision-scoped and recover after an expired lease. */
import { randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { configFromEnv, openDatabase, transaction } from "./index";
import { migrate } from "./migrate";
import { solveSnapshot } from "./scenarios";

type Work = { snapshot_key: string; snapshot_revision: number; attempts: number };
export function claimScenarioWork(db: Database, now = new Date()) {
  const owner = randomUUID(), stamp = now.toISOString();
  return transaction(db, () => {
    const row = db.query<Work, [string]>(`SELECT q.snapshot_key,q.snapshot_revision,q.attempts FROM scenario_work_queue q
      JOIN snapshot_publications p ON p.snapshot_key=q.snapshot_key AND p.revision=q.snapshot_revision AND p.state='current'
      WHERE (q.state='pending' OR (q.state='running' AND q.expires_at_utc<=?)) AND q.attempts<3
      ORDER BY q.updated_at_utc,q.snapshot_key LIMIT 1`).get(stamp);
    if (!row) return null;
    db.query(`UPDATE scenario_work_queue SET state='running',owner=?,expires_at_utc=?,updated_at_utc=?,attempts=attempts+1
      WHERE snapshot_key=? AND snapshot_revision=?`).run(owner, new Date(now.getTime() + 15 * 60000).toISOString(),
      stamp, row.snapshot_key, row.snapshot_revision);
    return { ...row, owner };
  });
}

export function workScenarios(db: Database, limit = 1) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("Invalid work limit");
  const results: Array<{ key: string; state: string }> = [];
  for (let i = 0; i < limit; i++) {
    const job = claimScenarioWork(db);
    if (!job) break;
    const key = job.snapshot_key;
    try {
      const result = solveSnapshot(db, key);
      const state = result.state === "pending" ? job.attempts + 1 >= 3 ? "failure" : "pending" : "done";
      transaction(db, () => db.query(`UPDATE scenario_work_queue SET state=?,owner=NULL,expires_at_utc=NULL,
        updated_at_utc=? WHERE snapshot_key=? AND snapshot_revision=? AND owner=?`)
        .run(state, new Date().toISOString(), key, job.snapshot_revision, job.owner));
      results.push({ key, state });
    } catch (error) {
      transaction(db, () => db.query(`UPDATE scenario_work_queue SET state=?,owner=NULL,expires_at_utc=NULL,
        error=?,updated_at_utc=? WHERE snapshot_key=? AND snapshot_revision=? AND owner=?`)
        .run(job.attempts + 1 >= 3 ? "failure" : "pending", error instanceof Error ? error.message : "Worker failed",
          new Date().toISOString(), key, job.snapshot_revision, job.owner));
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

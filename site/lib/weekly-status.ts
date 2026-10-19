import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { POLL_MODEL_VERSION, SOLVER_VERSION } from "../../packages/chars-algorithm/src/index";
import type { Ranking, SnapshotOption } from "./season-data";

export const STATUS_LABELS = {
  eliminated: "Eliminated", needs_help: "Needs help",
  controls_destiny: "Controls destiny", clinched: "Clinched",
} as const;
export type StatusLabel = keyof typeof STATUS_LABELS;
export type StatusState = "pending" | "incomplete" | "unsupported";
export type TeamStatus = { label: StatusLabel | null; state: StatusState | null;
  assumptions: string[]; pollDependent: boolean; path: { outcomes: Record<string, string>;
    pollOrder: string[]; winOut: boolean } | null };
export type WeeklyStatuses = Record<string, TeamStatus>;

const labels = Object.keys(STATUS_LABELS) as StatusLabel[];
export function statusFilter(value: string | undefined): StatusLabel | null {
  return labels.find(label => label === value) ?? null;
}
export function statusHref(base: string, week: string, search: string, view: string, status: StatusLabel | null): string {
  const params = new URLSearchParams({ week });
  if (search) params.set("q", search);
  if (view === "eligible") params.set("view", view);
  if (status) params.set("status", status);
  return `${base}?${params}`;
}
export function filterByStatus(rows: Ranking[], statuses: WeeklyStatuses, filter: StatusLabel | null): Ranking[] {
  return filter ? rows.filter(row => statuses[row.teamId]?.label === filter) : rows;
}
const pending = (state: StatusState): TeamStatus => ({ label: null, state, assumptions: [], pollDependent: false, path: null });
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
function parse(value: string | null): unknown {
  try { return value === null ? null : JSON.parse(value); } catch { return null; }
}

/** Read only certified results of the current publication and generation, in the caller's WAL read transaction. */
export function readWeeklyStatuses(db: Database, season: number, snapshot: SnapshotOption, rankings: Ranking[]): WeeklyStatuses {
  const result: WeeklyStatuses = Object.fromEntries(rankings.map(row => [row.teamId,
    pending(snapshot.coverage.complete ? "pending" : "incomplete")]));
  if (snapshot.kind === "selection_final" || snapshot.publicationState !== "current" || !snapshot.coverage.complete)
    return result;
  const publication = db.query<{ input_hash: string; generation: number | null; invalid: number }, [string, number, number]>(`
    SELECT s.input_hash, g.generation, EXISTS(SELECT 1 FROM snapshot_input_invalidations i
      WHERE i.snapshot_key=s.snapshot_key AND i.snapshot_revision=s.revision) AS invalid
    FROM snapshot_publications p JOIN snapshots s ON s.snapshot_key=p.snapshot_key AND s.revision=p.revision
    LEFT JOIN season_input_generations g ON g.season=s.season
    WHERE p.snapshot_key=? AND p.revision=? AND s.season=? AND p.state='current'
  `).get(snapshot.key, snapshot.revision, season);
  if (!publication || publication.invalid || !publication.generation) return result;
  const jobs = db.query<{ id: string; input_hash: string; state: string; poll_model_version: string;
    solver_version: string }, [string, number, number, string, string]>(`
    SELECT id,input_hash,state,poll_model_version,solver_version FROM scenario_jobs
    WHERE snapshot_key=? AND snapshot_revision=? AND input_generation=?
      AND poll_model_version=? AND solver_version=? AND state IN ('pending','proved','unsupported')
    ORDER BY updated_at_utc DESC
  `).all(snapshot.key, snapshot.revision, publication.generation, POLL_MODEL_VERSION, SOLVER_VERSION);
  // Different hashes in one generation cannot be resolved by choosing the newest job.
  if (new Set(jobs.map(job => job.input_hash)).size !== 1) return result;
  const job = jobs[0];
  if (!job || createHash("sha256").update(JSON.stringify([snapshot.key, snapshot.revision,
    POLL_MODEL_VERSION, SOLVER_VERSION, job.input_hash])).digest("hex") !== job.id) return result;
  const rows = db.query<{ team_id: string; state: string; label: string | null;
    assumptions_json: string; proof_metadata_json: string | null }, [string]>(`
    SELECT team_id,state,label,assumptions_json,proof_metadata_json FROM scenario_statuses WHERE job_id=?
  `).all(job.id);
  for (const row of rows) {
    if (!(row.team_id in result)) continue;
    const metadata = parse(row.proof_metadata_json);
    if (!object(metadata) || metadata.snapshotInputHash !== publication.input_hash) continue;
    const assumptions = parse(row.assumptions_json);
    const safeAssumptions = Array.isArray(assumptions) && assumptions.every(x => typeof x === "string") ? assumptions : [];
    if (row.state === "unsupported") {
      result[row.team_id] = pending("unsupported");
      continue;
    }
    if (row.state !== "proved" || !statusFilter(row.label ?? undefined) || !safeAssumptions.some(x => x.includes("all eligible poll orders"))) continue;
    const label = statusFilter(row.label ?? undefined)!;
    const witness = db.query<{ witness_json: string }, [string, string, string]>(`
      SELECT witness_json FROM scenario_witnesses WHERE job_id=? AND team_id=? AND kind=? ORDER BY sequence LIMIT 1
    `).get(job.id, row.team_id, label === "eliminated" ? "failing" : "qualifying_win_out");
    const raw = parse(witness?.witness_json ?? null);
    const path = object(raw) && object(raw.gameOutcomes) &&
      Object.values(raw.gameOutcomes).every(x => x === "home" || x === "away" || x === "tie") &&
      Array.isArray(raw.pollOrderTeamIds) && raw.pollOrderTeamIds.every(x => typeof x === "string") ?
      { outcomes: raw.gameOutcomes as Record<string, string>, pollOrder: raw.pollOrderTeamIds as string[],
        winOut: raw.kind === "qualifying_win_out" } : null;
    result[row.team_id] = { label, state: null, assumptions: safeAssumptions,
      pollDependent: metadata.pollDependent === true, path };
  }
  return result;
}

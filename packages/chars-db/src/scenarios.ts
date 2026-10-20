import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CALENDAR_POLICY_VERSION, MODEL_VERSION, POLICY_VERSION, POLL_MODEL_VERSION, SOLVER_VERSION, computeScenarios } from "../../chars-algorithm/src/index";
import type { ScenarioCheckpoint, ScenarioInput, ScenarioResult } from "../../chars-algorithm/src/scenarios";
import { openDatabase } from "./database";
import { readSeason, type SourceGameMetadata } from "./repository";
import { readPublished, type CalendarPolicy, type SnapshotArtifact } from "./snapshots";

const cache = () => process.env.CHARS_CACHE_PATH ?? ".cache";
const digest = (data: unknown) => createHash("sha256").update(JSON.stringify(data)).digest("hex");
const directory = () => join(cache(), "scenarios");

async function optional<T>(path: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback; throw error; }
}

async function atomic(path: string, content: string): Promise<void> {
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(temporary, content, { flag: "wx" }); await rename(temporary, path); }
  finally { await rm(temporary, { force: true }); }
}

export async function scenarioInput(snapshot: SnapshotArtifact): Promise<{ input: ScenarioInput; key: string }> {
  const year = snapshot.season;
  const metadata = await optional<Record<string, SourceGameMetadata>>(join(cache(), "source", `${year}-games.json`), {});
  const calendar = await optional<CalendarPolicy>(join(cache(), "source", `${year}-calendar.json`), {});
  const db = openDatabase();
  let source;
  try { source = readSeason(db.sqlite, year, metadata); }
  finally { db.close(); }
  // No verified freeze means no finite scenario universe, and thus no mathematical status.
  const freeze = calendar.freezeUtc && Date.parse(calendar.freezeUtc) > Date.parse(snapshot.gameCutoffUtc) ?
    calendar.freezeUtc : new Date(Date.parse(snapshot.gameCutoffUtc) + 1).toISOString();
  const input: ScenarioInput = {
    season: year, teams: source.teams, games: source.games,
    snapshot: { key: snapshot.key, season: year, revision: 0, inputHash: snapshot.sourceHash,
      policyVersion: snapshot.policyVersion, modelVersion: snapshot.modelVersion,
      calendarPolicyVersion: snapshot.calendarPolicyVersion },
    gameCutoffUtc: snapshot.gameCutoffUtc, selectionFreezeUtc: freeze,
    scheduleComplete: calendar.verified === true && !!calendar.freezeUtc &&
      Date.parse(calendar.freezeUtc) > Date.parse(snapshot.gameCutoffUtc) &&
      source.coverage.length === 0 && snapshot.coverage.length === 0
  };
  const key = digest({ snapshot, teams: source.teams, games: source.games, coverage: source.coverage,
    calendar, policy: POLICY_VERSION, model: MODEL_VERSION, calendarPolicy: CALENDAR_POLICY_VERSION,
    pollModel: POLL_MODEL_VERSION, solver: SOLVER_VERSION });
  return { input, key };
}

export async function readScenarioResult(snapshot: SnapshotArtifact): Promise<ScenarioResult | null> {
  try {
    const { key } = await scenarioInput(snapshot);
    const result = await optional<ScenarioResult | null>(join(directory(), `${key}.json`), null);
    return result?.proofs.every(proof => proof.snapshotKey === snapshot.key &&
      proof.pollModelVersion === POLL_MODEL_VERSION && proof.solverVersion === SOLVER_VERSION) ? result : null;
  } catch { return null; }
}

export async function solveSnapshot(snapshotKey: string, budgets: { maxCompletions?: number; maxRuntimeMs?: number;
  maxCheckpointBytes?: number; maxTrackedPollPaths?: number } = {}): Promise<ScenarioResult> {
  if (!/^[a-zA-Z0-9_-]+$/.test(snapshotKey)) throw new Error("Invalid snapshot key");
  const year = Number(snapshotKey.split("-")[0]);
  if (!Number.isSafeInteger(year)) throw new Error("Invalid snapshot season");
  const snapshot = (await readPublished(join(cache(), "snapshots"), year)).find(item => item.key === snapshotKey);
  if (!snapshot || snapshot.kind === "selection_final") throw new Error("Expected a published non-final snapshot key");
  const { input, key } = await scenarioInput(snapshot);
  await mkdir(directory(), { recursive: true });
  const path = join(directory(), `${key}.json`);
  const previous = await optional<ScenarioResult | null>(path, null);
  if (previous?.complete) return previous;
  const secretPath = join(directory(), "checkpoint.key");
  try { await writeFile(secretPath, randomBytes(32).toString("hex"), { flag: "wx", mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
  const secret = (await readFile(secretPath, "utf8")).trim();
  const result = computeScenarios({ ...input, ...budgets,
    checkpoint: previous?.checkpoint as ScenarioCheckpoint | undefined }, secret);
  await atomic(path, JSON.stringify(result));
  return result;
}

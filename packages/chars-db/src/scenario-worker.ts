import { solveSnapshot } from "./scenarios";

const index = process.argv.indexOf("--snapshot");
const key = process.argv[index + 1];
if (index < 0 || !key) throw new Error("Usage: bun run scenarios:solve --snapshot KEY");
const maxCompletions = Number(process.env.SCENARIO_MAX_COMPLETIONS ?? 1000);
const maxRuntimeMs = Number(process.env.SCENARIO_MAX_RUNTIME_MS ?? 30000);
const result = await solveSnapshot(key, { maxCompletions, maxRuntimeMs,
  maxCheckpointBytes: Number(process.env.SCENARIO_MAX_CHECKPOINT_BYTES ?? 16777216),
  maxTrackedPollPaths: Number(process.env.SCENARIO_MAX_TRACKED_POLL_PATHS ?? 10000) });
console.log(JSON.stringify({ snapshot: key, complete: result.complete, evaluated: result.evaluatedCompletions,
  total: result.possibleCompletions, pending: result.pendingReason,
  labels: Object.fromEntries(result.proofs.filter(proof => proof.label).map(proof => [proof.teamId, proof.label])) }));

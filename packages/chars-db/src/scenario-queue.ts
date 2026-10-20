import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { readPublished } from "./snapshots";
import { readScenarioResult, scenarioCoverageReady, solveSnapshot } from "./scenarios";

const root = join(process.env.CHARS_CACHE_PATH ?? ".cache", "snapshots");
const years = (await readdir(root)).filter(value => /^\d{4}$/.test(value)).sort().reverse();
for (const year of years) {
  const snapshots = await readPublished(root, Number(year));
  for (const snapshot of [...snapshots].reverse()) {
    if (snapshot.kind === "selection_final" || !scenarioCoverageReady(snapshot.coverage)) continue;
    const previous = await readScenarioResult(snapshot);
    if (previous?.complete || previous?.unsupportedReason || (previous && !previous.checkpoint)) continue;
    const result = await solveSnapshot(snapshot.key, {
      maxCompletions: Number(process.env.SCENARIO_MAX_COMPLETIONS ?? 1000),
      maxRuntimeMs: Number(process.env.SCENARIO_MAX_RUNTIME_MS ?? 30000),
      maxCheckpointBytes: Number(process.env.SCENARIO_MAX_CHECKPOINT_BYTES ?? 16777216),
      maxTrackedPollPaths: Number(process.env.SCENARIO_MAX_TRACKED_POLL_PATHS ?? 10000)
    });
    console.log(`${snapshot.key}: ${result.evaluatedCompletions} evaluated; ${result.pendingReason ?? "complete"}`);
    process.exit(0);
  }
}
console.log("No runnable scenario snapshot; incomplete schedules need source/calendar review.");

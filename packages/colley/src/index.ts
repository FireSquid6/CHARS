export * from "./types";
export { validateInput, buildSnapshot } from "./input";
export { calculateRecords, calculateColley } from "./rating";
export { selectInitialField, buildHeadToHead, applyCategorySwaps } from "./selection";
export { seedSelectedTeams, buildPlayInsAndBracket } from "./bracket";
export { analyzeScenarios } from "./scenarios";
export type { Witness, TeamProof, ScenarioResult } from "./scenarios";

import { buildSnapshot } from "./input";
import { calculateRecords, calculateColley } from "./rating";
import { selectInitialField, buildHeadToHead, applyCategorySwaps } from "./selection";
import { seedSelectedTeams, buildPlayInsAndBracket } from "./bracket";
import type { Input, Selection, Snapshot } from "./types";

/** Pure snapshot engine. Callers decide how to persist or display the returned data. */
export function calculateSelection(snapshot: Snapshot): Selection {
  if (!snapshot.complete) throw new Error(`Incomplete snapshot: ${snapshot.missing.join(", ")}`);
  const records = calculateRecords(snapshot);
  const ratings = calculateColley(snapshot);
  const initial = selectInitialField(snapshot, ratings);
  const graph = buildHeadToHead(snapshot);
  const final = applyCategorySwaps(initial, graph, ratings);
  const seeds = seedSelectedTeams(final, graph, ratings);
  const bracket = buildPlayInsAndBracket(final, seeds);
  return { snapshot, records, ratings: ratings.entries, initial, graph, final, seeds, bracket };
}

export function calculateInput(input: Input, cutoff: string): Selection {
  return calculateSelection(buildSnapshot(input, cutoff));
}

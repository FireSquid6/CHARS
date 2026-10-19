import { CALENDAR_POLICY_VERSION, MODEL_VERSION, POLICY_VERSION, type RecordStats, type SnapshotIdentity,
  type SelectionCategory, type SelectionRoute } from "./index";
import { selectField, type SelectionInput, type SelectionResult, type SelectionSwap } from "./selection";
import type { HeadToHeadEdge } from "./head-to-head";

/** A constraint is either an actual clean win or the Colley fallback within a raw SCC. */
export interface SeedingEdge {
  beforeTeamId: string;
  afterTeamId: string;
  reason: "head_to_head" | "cyclic_colley";
  supportingGameIds: string[];
}

export interface SeededTeam {
  teamId: string;
  colleyRank: number;
  colleyRating: number;
  adjustedRank: number;
  initialCategory: SelectionCategory;
  finalCategory: "bid" | "playin";
  originalRoute: SelectionRoute;
}

export interface SeedingResult {
  season: number;
  snapshot: SnapshotIdentity | null;
  policyVersion: typeof POLICY_VERSION;
  modelVersion: typeof MODEL_VERSION;
  calendarPolicyVersion: typeof CALENDAR_POLICY_VERSION;
  /** Completeness/publication checks belong to snapshot construction (step 7), not this pure engine. */
  publicationStatus: { state: "incomplete" | "provisional"; reason: string };
  cycleFallback: "original_full_fbs_scc_colley_chain";
  selection: SelectionResult;
  /** Includes eligible outsiders and ineligible FBS teams, not only seeded participants. */
  rankings: Array<{ teamId: string; record: RecordStats; colleyRank: number;
    colleyRating: number; adjustedRank: number | null; eligible: boolean;
    originalRoute: SelectionRoute; initialCategory: SelectionCategory;
    finalCategory: SelectionCategory; precisionMethod: string; residual: number }>;
  /** All selected teams, regardless of final selection category. */
  teams: SeededTeam[];
  edges: SeedingEdge[];
  /** The selected subset of each original cyclic SCC (including single-member subsets). */
  cyclicGroups: string[][];
  adjustedOrder: string[];
  cycleEdges: HeadToHeadEdge[];
  swaps: SelectionSwap[];
}

const compareIds = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

/** Calculate the adjusted order without reassigning the selection result's category labels. */
export function seedField(input: SelectionInput, snapshot: SnapshotIdentity | null = null): SeedingResult {
  if (snapshot) {
    if (snapshot.season !== input.season) throw new Error("Snapshot season does not match seeding input");
    if (snapshot.policyVersion !== POLICY_VERSION) throw new Error("Snapshot policyVersion does not match seeding policy");
    if (snapshot.modelVersion !== MODEL_VERSION) throw new Error("Snapshot modelVersion does not match Colley model");
    if (snapshot.calendarPolicyVersion !== CALENDAR_POLICY_VERSION) {
      throw new Error("Snapshot calendarPolicyVersion does not match selection calendar");
    }
  }
  const selection = selectField(input);
  const selected = new Set([...selection.bid, ...selection.playin]);
  const compare = input.ratings.compareTeamIds;
  const cyclicGroups = selection.graph.cyclicComponents
    .map(component => component.filter(id => selected.has(id)).sort(compare))
    .filter(group => group.length > 0);
  const edges: SeedingEdge[] = selection.graph.activeEdges
    .filter(edge => selected.has(edge.winnerTeamId) && selected.has(edge.loserTeamId))
    .map(edge => ({ beforeTeamId: edge.winnerTeamId, afterTeamId: edge.loserTeamId,
      reason: "head_to_head", supportingGameIds: [...edge.supportingGameIds] }));
  for (const group of cyclicGroups) for (let i = 1; i < group.length; i++) {
    edges.push({ beforeTeamId: group[i - 1]!, afterTeamId: group[i]!,
      reason: "cyclic_colley", supportingGameIds: [] });
  }
  edges.sort((a, b) => compareIds(a.beforeTeamId, b.beforeTeamId) ||
    compareIds(a.afterTeamId, b.afterTeamId) || compareIds(a.reason, b.reason));

  const outgoing = new Map([...selected].map(id => [id, [] as string[]]));
  const indegree = new Map([...selected].map(id => [id, 0]));
  for (const edge of edges) {
    outgoing.get(edge.beforeTeamId)!.push(edge.afterTeamId);
    indegree.set(edge.afterTeamId, indegree.get(edge.afterTeamId)! + 1);
  }
  const available = [...selected].filter(id => indegree.get(id) === 0);
  const adjustedOrder: string[] = [];
  while (available.length) {
    available.sort(compare);
    const id = available.shift()!;
    adjustedOrder.push(id);
    for (const next of outgoing.get(id)!) {
      const remaining = indegree.get(next)! - 1;
      indegree.set(next, remaining);
      if (remaining === 0) available.push(next);
    }
  }
  if (adjustedOrder.length !== selected.size) throw new Error("Seeding constraints contain a cycle");
  const rank = new Map(adjustedOrder.map((id, index) => [id, index + 1]));
  for (const edge of edges) {
    if (rank.get(edge.beforeTeamId)! >= rank.get(edge.afterTeamId)!) {
      throw new Error(`Seeding constraint violated: ${edge.beforeTeamId} -> ${edge.afterTeamId}`);
    }
  }
  const ratings = new Map(input.ratings.ratings.map(r => [r.teamId, r]));
  const categories = new Map(selection.teams.map(team => [team.teamId, team]));
  const teams: SeededTeam[] = adjustedOrder.map((teamId, index) => {
    const rating = ratings.get(teamId)!;
    const category = categories.get(teamId)!;
    if (category.finalCategory === "outside") throw new Error("Outside team appears in seeding order");
    return { teamId, colleyRank: rating.colleyRank, colleyRating: rating.colleyRating,
      adjustedRank: index + 1, initialCategory: category.initialCategory,
      finalCategory: category.finalCategory, originalRoute: category.originalRoute };
  });
  const records = new Map(input.records.map(entry => [entry.teamId, entry.record]));
  const rankings = input.ratings.ratings.map(rating => {
    const category = categories.get(rating.teamId)!;
    return { teamId: rating.teamId, record: records.get(rating.teamId)!,
      colleyRank: rating.colleyRank, colleyRating: rating.colleyRating,
      adjustedRank: rank.get(rating.teamId) ?? null, eligible: category.eligible,
      originalRoute: category.originalRoute, initialCategory: category.initialCategory,
      finalCategory: category.finalCategory, precisionMethod: rating.precisionMethod,
      residual: rating.residual };
  });
  const publicationStatus: SeedingResult["publicationStatus"] = snapshot ? {
    state: "provisional", reason: "Snapshot completeness and publication are not validated here; " +
      "step 7 must verify coverage, cutoffs, and source revisions before declaring a final bracket."
  } : { state: "incomplete", reason: "No snapshot identity or validated completeness metadata was supplied; " +
    "this synthetic bracket cannot be published as final." };
  return { season: input.season, snapshot, policyVersion: POLICY_VERSION, modelVersion: MODEL_VERSION,
    calendarPolicyVersion: CALENDAR_POLICY_VERSION, publicationStatus,
    cycleFallback: "original_full_fbs_scc_colley_chain", selection, teams, edges,
    rankings, cyclicGroups, adjustedOrder, cycleEdges: selection.graph.suppressedEdges,
    swaps: selection.swaps };
}

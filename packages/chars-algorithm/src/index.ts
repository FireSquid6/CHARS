export const POLICY_VERSION = "selection-v1" as const;
export const MODEL_VERSION = "colley-fbs-only-v1" as const;
export const CALENDAR_POLICY_VERSION = "pre-ccg-weekend-v1" as const;
export const POLL_MODEL_VERSION = "all-eligible-poll-orders-v1" as const;
export const SOLVER_VERSION = "scenarios-v1" as const;

export { computeColley } from "./colley";
export type { ColleyResult, ColleyTeamRating } from "./colley";
export { colleyInputFingerprint, computeEligibility, includedRegularGames, recordIsEligible } from "./eligibility";
export type { SeasonGames, IncludedGame } from "./eligibility";
export { buildHeadToHead } from "./head-to-head";
export type { HeadToHeadEdge, HeadToHeadGraph } from "./head-to-head";
export { selectField } from "./selection";
export type { SelectionInput, SelectedTeam, SelectionSwap, SelectionResult as FieldSelectionResult } from "./selection";
export { seedField } from "./seeding";
export type { SeedingEdge, SeededTeam, SeedingResult } from "./seeding";
export { buildBracket, computePlayoff, standardSeedOrder } from "./brackets";
export type { PlayinPair, MainSlot, MainMatch, BracketEntry, BracketResult } from "./brackets";

export type SeasonState = "preseason" | "current" | "final" | "incomplete";
export type Membership = "fbs" | "fcs" | "other";
export type GameType = "regular" | "ccg" | "bowl" | "playoff" | "unknown";
export type GameStatus = "scheduled" | "in_progress" | "completed" | "cancelled" | "postponed";
export type PollType = "ap" | "cfp";
export type SnapshotKind = "partial" | "week_final" | "selection_final";
export type SelectionRoute = "rating_bid" | "colley_minimum_bid" | "rating_playin" | "poll_playin" | "outside";
export type SelectionCategory = "bid" | "playin" | "outside";
export type ScenarioState = "pending" | "running" | "proved" | "unsupported";
export type ScenarioLabel = "clinched" | "eliminated" | "controls_destiny" | "needs_help";

export interface Season {
  year: number;
  state: SeasonState;
  selectionFreezeUtc: string | null;
  calendarPolicyVersion: string;
  coverage: string;
}

export interface Team {
  id: string;
  providerId: string | null;
  name: string;
  abbreviation: string | null;
}

export interface TeamSeason {
  season: number;
  teamId: string;
  membership: Membership;
  conference: string | null;
}

export interface Game {
  id: string;
  providerGameId: string;
  season: number;
  week: number | null;
  homeTeamId: string;
  awayTeamId: string;
  kickoffUtc: string | null;
  homeScore: number | null;
  awayScore: number | null;
  status: GameStatus;
  completed: boolean;
  providerSeasonType: string;
  applicationGameType: GameType;
  classificationSource: string;
  payloadHash: string;
  resultRevision: number;
}

export interface PollRelease {
  id: string;
  season: number;
  type: PollType;
  gameWeek: number | null;
  releasedAtUtc: string | null;
  effectiveAtUtc: string | null;
  sourceHash: string;
}

export interface PollEntry {
  releaseId: string;
  teamId: string;
  rank: number;
  points: number | null;
}

export interface SnapshotIdentity {
  key: string;
  season: number;
  revision: number;
  inputHash: string;
  policyVersion: string;
  modelVersion: string;
  calendarPolicyVersion: string;
}

export interface Snapshot extends SnapshotIdentity {
  kind: SnapshotKind;
  week: number | null;
  gameCutoffUtc: string;
  pollCutoffUtc: string | null;
  pollReleaseId: string | null;
  coverage: string;
  publishedAtUtc: string | null;
}

export interface RecordStats {
  wins: number;
  losses: number;
  ties: number;
  percentageNumerator: number;
  percentageDenominator: number;
}

export interface ComputedRanking {
  snapshotKey: string;
  teamId: string;
  record: RecordStats;
  colleyRating: number;
  colleyRank: number;
  adjustedRank: number | null;
  residual: number;
  precisionMethod: string;
  eligible: boolean;
  eligibilityReason: string | null;
  originalRoute: SelectionRoute;
  finalCategory: SelectionCategory;
}

export interface SwapEvent {
  snapshotKey: string;
  sequence: number;
  winnerTeamId: string;
  loserTeamId: string;
  winnerBefore: SelectionCategory;
  loserBefore: SelectionCategory;
  supportingGameIds: string[];
}

export interface BracketSlot {
  snapshotKey: string;
  round: number;
  position: number;
  seed: number | null;
  teamAId: string | null;
  teamBId: string | null;
  sourceSlotA: string | null;
  sourceSlotB: string | null;
  isBye: boolean;
}

export interface SelectionResult {
  identity: SnapshotIdentity;
  rankings: ComputedRanking[];
  swaps: SwapEvent[];
  bracket: BracketSlot[];
}

export interface ScenarioIdentity {
  snapshotKey: string;
  snapshotRevision: number;
  teamId: string;
  pollModelVersion: string;
  solverVersion: string;
}

export interface ScenarioWitness {
  kind: "qualifying" | "failing" | "qualifying_win_out" | "failing_win_out";
  gameOutcomes: Record<string, "home" | "away" | "tie">;
  pollOrderTeamIds: string[];
  assumptions: string[];
}

export interface ScenarioProof extends ScenarioIdentity {
  state: ScenarioState;
  label: ScenarioLabel | null;
  assumptions: string[];
  proofMetadata: string | null;
  runtimeMs: number | null;
  witnesses: ScenarioWitness[];
}

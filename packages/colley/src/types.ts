export type Category = "bid" | "playin" | "outside";
export type Route = "rating_bid" | "colley_minimum_bid" | "rating_playin" | "poll_playin" | "outside";
export interface Team { id: string; name: string; fbs: boolean }
export interface Game {
  id: string; year: number; week: number; home: string; away: string;
  kind: "regular" | "ccg" | "bowl" | "playoff";
  scheduledAt: string; completedAt?: string;
  status: "completed" | "scheduled" | "cancelled";
  homeScore: number | null; awayScore: number | null;
  /** Historical games can allow a third, tied outcome in scenario analysis. */
  tiesAllowed?: boolean;
}
export interface Poll {
  id: string; year: number; week: number; releasedAt: string;
  type: "AP" | "CFP"; entries: { teamId: string; rank: number }[];
}
export interface Input {
  year: number; teams: Team[]; games: Game[]; polls: Poll[];
  /** End of last full regular-season weekend before the first CCG; excludes late CCG-week games. */
  terminalCutoff: string;
  /** Caller asserts that these source collections are complete for this season. */
  membershipComplete: boolean; scheduleComplete: boolean; pollsComplete: boolean;
}
export interface Snapshot {
  input: Input; cutoff: string; games: Game[]; remaining: Game[];
  poll: Poll | null; pollFallback: boolean; complete: boolean; missing: string[];
  inputHash: string; policyVersion: "colley-fbs-1";
}
export interface RecordResult { teamId: string; wins: number; losses: number; ties: number; gamesPlayed: number; eligible: boolean; reason: string }
export interface Rating { teamId: string; rating: number; rawRank: number }
export interface Ratings { entries: Rating[]; residual: number; model: "fbs-only-1"; compare: (a: string, b: string) => number; atLeast: (id: string, threshold: ".90" | ".85") => boolean }
export interface FieldEntry { teamId: string; category: Category; route: Route }
export interface Edge { winner: string; loser: string; gameIds: string[] }
export interface Graph { raw: Edge[]; active: Edge[]; suppressed: Edge[]; cycles: string[][] }
export interface SwapEvent { winner: string; loser: string; gameIds: string[]; winnerFrom: Category; loserFrom: Category; winnerTo: Category; loserTo: Category }
export interface Field { entries: FieldEntry[]; bidCount: number; playinCount: number; swaps: SwapEvent[]; unapplied: Edge[] }
export interface Seed { teamId: string; adjustedRank: number; rawRank: number; rating: number; category: Category; route: Route }
export interface Slot { seed: number; alternatives: string[]; bye?: boolean }
export interface Bracket { playInBye: string | null; pairs: [string, string][]; slots: Slot[]; size: number; firstRound: [number | null, number | null][]; rounds: [number | null, number | null][][] }
export interface Selection { snapshot: Snapshot; records: RecordResult[]; ratings: Rating[]; initial: Field; graph: Graph; final: Field; seeds: Seed[]; bracket: Bracket }

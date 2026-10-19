import type { ColleyResult } from "./colley";
import { colleyInputFingerprint, computeEligibility, type SeasonGames } from "./eligibility";
import { buildHeadToHead, type HeadToHeadEdge, type HeadToHeadGraph } from "./head-to-head";
import type { PollEntry, RecordStats, SelectionCategory, SelectionRoute } from "./index";

const compareIds = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

export interface SelectionInput extends SeasonGames {
  /** Ratings must be calculated for this snapshot's entire FBS universe with computeColley. */
  ratings: ColleyResult;
  /** Supplied snapshot records are checked against included regular games, including FCS results. */
  records: readonly { teamId: string; record: RecordStats }[];
  /** Entries of the chosen contemporaneous release; omitted entries cannot top up the field. */
  pollEntries: readonly Pick<PollEntry, "teamId" | "rank">[];
}

export interface SelectedTeam {
  teamId: string;
  eligible: boolean;
  originalRoute: SelectionRoute;
  initialCategory: SelectionCategory;
  finalCategory: SelectionCategory;
}

export interface SelectionSwap {
  sequence: number;
  winnerTeamId: string;
  loserTeamId: string;
  winnerPosition: number;
  loserPosition: number;
  winnerBefore: SelectionCategory;
  loserBefore: SelectionCategory;
  supportingGameIds: string[];
}

export interface SelectionResult {
  season: number;
  teams: SelectedTeam[];
  initialBid: string[];
  initialPlayin: string[];
  bid: string[];
  playin: string[];
  outside: string[];
  /** Working order after exact-position exchanges; not an adjusted seeding order. */
  eligibleOrder: string[];
  graph: HeadToHeadGraph;
  swaps: SelectionSwap[];
  unappliedOutsiderBidClaims: HeadToHeadEdge[];
  shortField: boolean;
}

export function selectField(input: SelectionInput): SelectionResult {
  const graph = buildHeadToHead(input);
  const fbs = input.teams.filter(team => team.membership === "fbs").map(team => team.teamId);
  const fbsSet = new Set(fbs);
  const ratings = input.ratings.ratings;
  if (ratings.length !== fbsSet.size || new Set(ratings.map(r => r.teamId)).size !== fbsSet.size ||
    ratings.some(r => !fbsSet.has(r.teamId))) throw new Error("Ratings must cover every FBS team exactly once");
  const recordById = new Map<string, RecordStats>();
  for (const { teamId, record } of input.records) {
    if (!fbsSet.has(teamId) || recordById.has(teamId)) throw new Error(`Unexpected or duplicate record: ${teamId}`);
    const games = record.wins + record.losses + record.ties;
    if (!Number.isSafeInteger(games) || record.percentageNumerator !== 2 * record.wins + record.ties ||
      record.percentageDenominator !== 2 * games) throw new Error(`Invalid record percentage: ${teamId}`);
    recordById.set(teamId, record);
  }
  if (recordById.size !== fbsSet.size) throw new Error("Records must cover every FBS team exactly once");
  const computed = computeEligibility(input);
  for (const [teamId, { record }] of computed) {
    const supplied = recordById.get(teamId)!;
    if (supplied.wins !== record.wins || supplied.losses !== record.losses || supplied.ties !== record.ties ||
      supplied.percentageNumerator !== record.percentageNumerator ||
      supplied.percentageDenominator !== record.percentageDenominator) {
      throw new Error(`Record disagrees with included games: ${teamId}`);
    }
  }
  if (input.ratings.inputFingerprint !== colleyInputFingerprint(input)) {
    throw new Error("Colley ratings disagree with season membership or included outcomes");
  }
  const eligible = new Set([...computed].filter(([, value]) => value.eligible).map(([id]) => id));
  const compare = input.ratings.compareTeamIds;
  const ordered = [...eligible].sort(compare);
  const bid = ordered.filter(id => input.ratings.meetsThreshold(id, "0.90"));
  const selected = new Set(bid);
  const route = new Map<string, SelectionRoute>(bid.map(id => [id, "rating_bid"]));
  for (const id of ordered) {
    if (bid.length >= 4) break;
    if (selected.has(id)) continue;
    bid.push(id);
    selected.add(id);
    route.set(id, "colley_minimum_bid");
  }
  const playin: string[] = [];
  for (const id of ordered) {
    if (selected.has(id) || !input.ratings.meetsThreshold(id, "0.85")) continue;
    playin.push(id);
    selected.add(id);
    route.set(id, "rating_playin");
  }
  const seenPoll = new Set<string>();
  for (const entry of input.pollEntries) {
    if (!Number.isSafeInteger(entry.rank) || entry.rank < 1 || seenPoll.has(entry.teamId)) {
      throw new Error(`Invalid or duplicate poll entry: ${entry.teamId}`);
    }
    seenPoll.add(entry.teamId);
  }
  for (const entry of [...input.pollEntries].sort((a, b) => a.rank - b.rank ||
    (fbsSet.has(a.teamId) && fbsSet.has(b.teamId) ? compare(a.teamId, b.teamId) :
      compareIds(a.teamId, b.teamId)))) {
    if (selected.size >= 12) break;
    if (!eligible.has(entry.teamId) || selected.has(entry.teamId)) continue;
    playin.push(entry.teamId);
    selected.add(entry.teamId);
    route.set(entry.teamId, "poll_playin");
  }
  const initialBid = [...bid].sort(compare), initialPlayin = [...playin].sort(compare);
  const D = bid.length, P = playin.length;
  const list = [...initialBid, ...initialPlayin, ...ordered.filter(id => !selected.has(id))];
  const category = (position: number): SelectionCategory => position < D ? "bid" : position < D + P ? "playin" : "outside";
  const swaps: SelectionSwap[] = [];
  const seenStates = new Set<string>();
  while (true) {
    const state = JSON.stringify(list);
    if (seenStates.has(state)) throw new Error("Selection swap cycle");
    seenStates.add(state);
    const position = new Map(list.map((id, i) => [id, i]));
    const claims = graph.activeEdges.flatMap(edge => {
      const winnerPosition = position.get(edge.winnerTeamId), loserPosition = position.get(edge.loserTeamId);
      if (winnerPosition === undefined || loserPosition === undefined) return [];
      const winnerBefore = category(winnerPosition), loserBefore = category(loserPosition);
      if (!((winnerBefore === "playin" && loserBefore === "bid") ||
        (winnerBefore === "outside" && loserBefore === "playin"))) return [];
      return [{ edge, winnerPosition, loserPosition, winnerBefore, loserBefore }];
    });
    claims.sort((a, b) => (a.winnerBefore === "playin" ? 0 : 1) - (b.winnerBefore === "playin" ? 0 : 1) ||
      a.loserPosition - b.loserPosition || compare(a.edge.winnerTeamId, b.edge.winnerTeamId) ||
      compareIds(a.edge.loserTeamId, b.edge.loserTeamId));
    const claim = claims[0];
    if (!claim) break;
    const { edge, winnerPosition, loserPosition, winnerBefore, loserBefore } = claim;
    [list[winnerPosition], list[loserPosition]] = [list[loserPosition]!, list[winnerPosition]!];
    swaps.push({ sequence: swaps.length + 1, winnerTeamId: edge.winnerTeamId, loserTeamId: edge.loserTeamId,
      winnerPosition, loserPosition, winnerBefore, loserBefore, supportingGameIds: [...edge.supportingGameIds] });
  }
  const finalCategory = new Map(list.map((id, i) => [id, category(i)]));
  const teams = [...fbs].sort(compare).map(teamId => ({ teamId, eligible: eligible.has(teamId),
    originalRoute: route.get(teamId) ?? "outside" as SelectionRoute,
    initialCategory: initialBid.includes(teamId) ? "bid" as const :
      initialPlayin.includes(teamId) ? "playin" as const : "outside" as const,
    finalCategory: finalCategory.get(teamId) ?? "outside" as SelectionCategory }));
  const unappliedOutsiderBidClaims = graph.activeEdges.filter(edge =>
    finalCategory.get(edge.winnerTeamId) === "outside" && finalCategory.get(edge.loserTeamId) === "bid");
  return { season: input.season, teams, initialBid, initialPlayin,
    bid: list.slice(0, D), playin: list.slice(D, D + P), outside: list.slice(D + P), eligibleOrder: list,
    graph, swaps, unappliedOutsiderBidClaims, shortField: D + P < 12 };
}

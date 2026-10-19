import { describe, expect, test } from "bun:test";
import { computeColley, computeEligibility } from "../src/index";
import { buildHeadToHead } from "../src/head-to-head";
import { selectField, type SelectionInput } from "../src/selection";
import type { ColleyResult } from "../src/colley";
import type { Game, TeamSeason } from "../src/index";

const season = 2026;
const teams = (...ids: string[]): TeamSeason[] => ids.map(teamId => ({ season, teamId,
  membership: teamId === "FCS" ? "fcs" : "fbs", conference: null }));
function game(id: string, winner: string, loser: string, changes: Partial<Game> = {}): Game {
  return { id, providerGameId: id, season, week: 1, homeTeamId: winner, awayTeamId: loser,
    homeScore: 1, awayScore: 0, status: "completed", completed: true, kickoffUtc: null,
    providerSeasonType: "regular", applicationGameType: "regular", classificationSource: "fixture",
    payloadHash: id, resultRevision: 1, ...changes };
}
function fixture(ratings: Record<string, number>, games: Game[] = [],
  options: { ineligible?: string[]; poll?: { teamId: string; rank: number }[] } = {}): SelectionInput {
  const ids = Object.keys(ratings).sort();
  const compare = (a: string, b: string) => ratings[b]! - ratings[a]! || a.localeCompare(b);
  const ordered = [...ids].sort(compare);
  const result: ColleyResult = { ratings: ordered.map((teamId, i) => ({ teamId, colleyRating: ratings[teamId]!,
    colleyRank: i + 1, residual: 0, errorBound: 0, precisionMethod: "cholesky" })),
  compareTeamIds: compare, meetsThreshold: (id, threshold) => ratings[id]! >= Number(threshold) };
  // FCS games establish eligibility without perturbing the FBS-only Colley or H2H graph.
  const fcsGames = ids.flatMap(id => Array.from({ length: 12 }, (_, i) =>
    game(`fcs-${id}-${i}`, id, "FCS", { homeScore: i < (options.ineligible?.includes(id) ? 8 : 12) ? 1 : 0,
      awayScore: i < (options.ineligible?.includes(id) ? 8 : 12) ? 0 : 1 })));
  const allGames = [...games, ...fcsGames];
  const roster = teams(...ids, "FCS");
  return { season, teams: roster, games: allGames, ratings: result,
    records: [...computeEligibility({ season, teams: roster, games: allGames })].map(([teamId, { record }]) => ({ teamId, record })),
    pollEntries: options.poll ?? [] };
}
const categories = (input: SelectionInput) => Object.fromEntries(selectField(input).teams.map(t => [t.teamId, t.finalCategory]));

describe("stage 1", () => {
  test("rejects a fabricated 9-3 record with zero included games", () => {
    const input = fixture({ A: .99, B: .8 });
    const forged = { wins: 9, losses: 3, ties: 0, percentageNumerator: 18, percentageDenominator: 24 };
    expect(() => selectField({ ...input, games: [], records: [
      { teamId: "A", record: forged }, { teamId: "B", record: forged }],
      pollEntries: [{ teamId: "A", rank: 1 }] })).toThrow(/Record disagrees with included games/);
  });

  test("rejects stale records when an included FCS outcome changes", () => {
    const input = fixture({ A: .93, B: .8 });
    const games = input.games.map(g => g.id === "fcs-A-0" ? { ...g, homeScore: 0, awayScore: 1 } : g);
    expect(() => selectField({ ...input, games })).toThrow(/Record disagrees with included games: A/);
  });

  test("minimum four, exact eligibility, routes, no extra Colley top-up and short field", () => {
    const input = fixture({ A: .91, B: .84, C: .83, D: .82, E: .81, F: .80, G: .99 }, [],
      { ineligible: ["G", "F"], poll: [{ teamId: "G", rank: 1 }, { teamId: "F", rank: 2 },
        { teamId: "E", rank: 3 }] });
    const result = selectField(input);
    expect(result.initialBid).toEqual(["A", "B", "C", "D"]);
    expect(result.initialPlayin).toEqual(["E"]);
    expect(result.shortField).toBe(true);
    expect(result.teams.map(t => [t.teamId, t.originalRoute])).toEqual([
      ["G", "outside"], ["A", "rating_bid"], ["B", "colley_minimum_bid"],
      ["C", "colley_minimum_bid"], ["D", "colley_minimum_bid"],
      ["E", "poll_playin"], ["F", "outside"]]);
  });

  test("rating paths may exceed twelve and poll never caps them", () => {
    const ratings = Object.fromEntries(Array.from({ length: 15 }, (_, i) => [`T${i}`, .95 - i * .001]));
    const result = selectField(fixture(ratings));
    expect(result.bid).toHaveLength(15);
    expect(result.playin).toHaveLength(0);
    expect(result.shortField).toBe(false);
  });

  test("exact .85 starts a play-in after four bids; threshold decisions use Colley's predicate", () => {
    const input = fixture({ A: .95, B: .94, C: .93, D: .92, E: .85, F: .84999999 });
    const meetsThreshold = input.ratings.meetsThreshold;
    input.ratings.meetsThreshold = (id, threshold) => id === "E" && threshold === "0.85" ||
      (id !== "E" && meetsThreshold(id, threshold));
    const r = selectField(input);
    expect(r.initialPlayin).toEqual(["E"]);
    expect(r.teams.find(t => t.teamId === "E")?.originalRoute).toBe("rating_playin");
    expect(r.teams.find(t => t.teamId === "F")?.originalRoute).toBe("outside");
  });

  test("poll tie breaks by Colley; ineligible 8-4 is skipped even if field stays short", () => {
    const result = selectField(fixture({ A: .8, B: .79, C: .78, D: .77, E: .76, F: .75, G: .74 }, [],
      { ineligible: ["E"], poll: [{ teamId: "E", rank: 1 }, { teamId: "G", rank: 2 },
        { teamId: "F", rank: 2 }] }));
    expect(result.initialPlayin).toEqual(["F", "G"]);
    expect(result.shortField).toBe(true);
    expect(result.teams.find(t => t.teamId === "E")?.finalCategory).toBe("outside");
  });

  test("computed exact .90 and .85 decisions are used rather than rounded display ratings", () => {
    const chain = (ab: number, bc: number) => [
      ...Array.from({ length: ab }, (_, i) => game(`ab${i}`, "A", "B")),
      ...Array.from({ length: bc }, (_, i) => game(`bc${i}`, "B", "C"))];
    const ninetyGames = chain(8, 8);
    const ninety = { season, teams: teams("A", "B", "C"), games: ninetyGames };
    const n = selectField({ ...ninety, ratings: computeColley(ninety),
      records: [...computeEligibility(ninety)].map(([teamId, { record }]) => ({ teamId, record })), pollEntries: [] });
    expect(n.teams.find(t => t.teamId === "A")?.originalRoute).toBe("rating_bid");
    const eightyFive = { season, teams: teams("A", "B", "C"), games: chain(5, 4) };
    const exact = computeColley(eightyFive);
    expect(exact.meetsThreshold("A", "0.85")).toBe(true);
    expect(exact.meetsThreshold("A", "0.90")).toBe(false);
    const r = selectField({ ...eightyFive, ratings: exact,
      records: [...computeEligibility(eightyFive)].map(([teamId, { record }]) => ({ teamId, record })), pollEntries: [] });
    expect(r.teams.find(t => t.teamId === "A")?.originalRoute).toBe("colley_minimum_bid");
  });
});

describe("clean head-to-head and SCC", () => {
  test("split, tie, repeat wins; ignore FCS and postseason; all FBS vertices", () => {
    const input = fixture({ A: .9, B: .8, C: .7, D: .6 }, [game("ab2", "A", "B"),
      game("ab1", "A", "B"), game("bc", "B", "C"), game("cb", "C", "B"),
      game("cd", "C", "D"), game("tie", "C", "D", { homeScore: 0, awayScore: 0 }),
      game("fcs", "A", "FCS"), game("bowl", "D", "A", { applicationGameType: "bowl" })]);
    const graph = buildHeadToHead(input);
    expect(graph.rawEdges).toEqual([{ winnerTeamId: "A", loserTeamId: "B", supportingGameIds: ["ab1", "ab2"] }]);
    expect(graph.components).toEqual([["A"], ["B"], ["C"], ["D"]]);
  });

  for (const cycle of [["A", "B", "C"], ["A", "B", "C", "D"]]) {
    test(`${cycle.length}-cycle suppresses internal edges, not external ones`, () => {
      const games = cycle.map((id, i) => game(`c${i}`, id, cycle[(i + 1) % cycle.length]!));
      games.push(game("external", "B", "X"));
      const graph = buildHeadToHead(fixture(Object.fromEntries([...cycle, "X"].map((id, i) => [id, .9 - i * .02])), games));
      expect(graph.cyclicComponents).toEqual([cycle]);
      expect(graph.suppressedEdges).toHaveLength(cycle.length);
      expect(graph.activeEdges.map(e => [e.winnerTeamId, e.loserTeamId])).toEqual([["B", "X"]]);
    });
  }

  test("overlapping cycles and ineligible cycle member are included before selection", () => {
    const input = fixture({ A: .94, B: .9, C: .86, D: .8, E: .7 }, [
      game("ab", "A", "B"), game("bc", "B", "C"), game("ca", "C", "A"),
      game("cd", "C", "D"), game("db", "D", "B"), game("ae", "A", "E")], { ineligible: ["D"] });
    const r = selectField(input);
    expect(r.graph.cyclicComponents).toEqual([["A", "B", "C", "D"]]);
    expect(r.graph.activeEdges.map(e => e.loserTeamId)).toEqual(["E"]);
    expect(r.swaps).toEqual([]);
  });
});

describe("ordered category exchanges", () => {
  const base = { A: .96, B: .95, C: .94, D: .93, P: .88, O: .7, X: .69 };
  test("play-in takes bid, outsider takes play-in, category sizes and routes remain", () => {
    const r = selectField(fixture(base, [game("pa", "P", "A"), game("op", "O", "P")]));
    expect(r.swaps.map(s => [s.winnerTeamId, s.loserTeamId, s.winnerBefore, s.loserBefore])).toEqual([
      ["P", "A", "playin", "bid"]]);
    expect(r.bid).toEqual(["P", "B", "C", "D"]);
    expect(r.unappliedOutsiderBidClaims.map(e => [e.winnerTeamId, e.loserTeamId])).toEqual([["O", "P"]]);
  });

  test("outsider replaces play-in and leaves bid count unchanged", () => {
    const r = selectField(fixture(base, [game("op", "O", "P")]));
    expect(r.swaps.map(s => [s.winnerTeamId, s.loserTeamId])).toEqual([["O", "P"]]);
    expect(r.bid).toEqual(["A", "B", "C", "D"]);
    expect(r.playin).toEqual(["O"]);
  });

  test("two-stage outsider admission uses actual edges at each crossing", () => {
    const input = fixture({ A: .95, B: .94, C: .93, D: .92, P: .87, O: .7 },
      [game("op", "O", "P"), game("od", "O", "D")]);
    const r = selectField(input);
    expect(r.swaps.map(s => [s.winnerTeamId, s.loserTeamId])).toEqual([["O", "P"], ["O", "D"]]);
    expect(categories(input)).toEqual({ A: "bid", B: "bid", C: "bid", D: "playin", P: "outside", O: "bid" });
    expect(r.teams.find(t => t.teamId === "O")?.originalRoute).toBe("outside");
  });

  test("outsider direct-only claim is reported and never admitted by reachability", () => {
    const r = selectField(fixture({ A: .95, B: .94, C: .93, D: .92, P: .87, O: .7 },
      [game("od", "O", "D"), game("ap", "A", "P")]));
    expect(r.swaps).toEqual([]);
    expect(r.unappliedOutsiderBidClaims.map(e => [e.winnerTeamId, e.loserTeamId])).toEqual([["O", "D"]]);
  });

  test("an ineligible clean winner cannot cross either boundary", () => {
    const r = selectField(fixture({ A: .95, B: .94, C: .93, D: .92, P: .87, O: .99 },
      [game("oa", "O", "A"), game("op", "O", "P")], { ineligible: ["O"] }));
    expect(r.swaps).toEqual([]);
    expect(r.graph.activeEdges).toHaveLength(2);
    expect(r.unappliedOutsiderBidClaims).toEqual([]);
  });

  test("multiple claimants prioritize bid crossing, loser position, then winner Colley; shuffle stable", () => {
    const input = fixture({ A: .97, B: .96, C: .95, D: .94, P: .88, Q: .87, O: .72, X: .71 },
      [game("qa", "Q", "A"), game("pa", "P", "A"), game("qb", "Q", "B"),
        game("op", "O", "P"), game("xp", "X", "P")]);
    const original = selectField(input);
    expect(original.swaps[0]?.winnerTeamId).toBe("P");
    expect(original.swaps[0]?.loserTeamId).toBe("A");
    const shuffled = selectField({ ...input, games: [...input.games].reverse(), teams: [...input.teams].reverse(),
      records: [...input.records].reverse(), pollEntries: [...input.pollEntries].reverse() });
    expect(shuffled).toEqual(original);
    expect(original.bid).toHaveLength(4);
    expect(original.playin).toHaveLength(2);
    expect(new Set([...original.bid, ...original.playin]).size).toBe(6);
  });

  test("chain never invents an A-over-C swap; losing bid may later lose play-in", () => {
    const r = selectField(fixture({ A: .7, B: .87, C: .93, D: .94, E: .95, F: .96 },
      [game("ab", "A", "B"), game("bc", "B", "C"), game("ac", "A", "C")]));
    expect(r.graph.activeEdges).toHaveLength(3);
    expect(r.swaps.map(s => [s.winnerTeamId, s.loserTeamId])).toEqual([["B", "C"], ["A", "C"], ["A", "B"]]);
    expect(r.bid).toContain("A");
    const onlyChain = selectField(fixture({ A: .7, B: .87, C: .93, D: .94, E: .95, F: .96 },
      [game("ab", "A", "B"), game("bc", "B", "C")]));
    expect(onlyChain.swaps.map(s => [s.winnerTeamId, s.loserTeamId])).toEqual([["B", "C"]]);
  });

  test("generated acyclic graphs terminate, keep exact category sizes and have no remaining legal claims", () => {
    const ids = Array.from({ length: 9 }, (_, i) => `T${i}`);
    const ratings = Object.fromEntries(ids.map((id, i) => [id, .96 - i * .025]));
    for (let seed = 0; seed < 32; seed++) {
      const games: Game[] = [];
      for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
        if ((i * 11 + j * 7 + seed * 13) % 5 < 2) games.push(game(`${i}-${j}`, ids[j]!, ids[i]!));
      }
      const input = fixture(ratings, games);
      const r = selectField(input);
      expect(r.bid.length).toBe(r.initialBid.length);
      expect(r.playin.length).toBe(r.initialPlayin.length);
      expect(r.swaps.length).toBeLessThan(100);
      const final = Object.fromEntries(r.teams.map(team => [team.teamId, team.finalCategory]));
      for (const edge of r.graph.activeEdges) {
        expect([final[edge.winnerTeamId], final[edge.loserTeamId]]).not.toEqual(["playin", "bid"]);
        expect([final[edge.winnerTeamId], final[edge.loserTeamId]]).not.toEqual(["outside", "playin"]);
      }
      expect(selectField({ ...input, games: [...input.games].reverse() })).toEqual(r);
    }
  });
});

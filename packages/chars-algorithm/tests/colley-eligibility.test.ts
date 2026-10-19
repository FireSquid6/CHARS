import { describe, expect, test } from "bun:test";
import { computeColley } from "../src/colley";
import { computeEligibility, recordIsEligible } from "../src/eligibility";
import type { Game, TeamSeason } from "../src/index";

const teams = (...ids: string[]): TeamSeason[] => ids.map(teamId => ({ teamId, season: 2026,
  membership: teamId === "FCS" ? "fcs" : "fbs", conference: null }));
function game(id: string, homeTeamId: string, awayTeamId: string, homeScore: number | null,
  awayScore: number | null, changes: Partial<Game> = {}): Game {
  return { id, providerGameId: id, season: 2026, week: 1, homeTeamId, awayTeamId, kickoffUtc: null,
    homeScore, awayScore, status: "completed", completed: true, providerSeasonType: "regular",
    applicationGameType: "regular", classificationSource: "fixture", payloadHash: id, resultRevision: 1, ...changes };
}

describe("Colley FBS-only universe", () => {
  test("no games retains all FBS vertices at .500", () => {
    const result = computeColley({ teams: teams("B", "A", "FCS"), games: [] });
    expect(result.ratings.map(r => [r.teamId, r.colleyRating, r.colleyRank])).toEqual([["A", .5, 1], ["B", .5, 2]]);
    expect(result.compareTeamIds("B", "A")).toBe(1);
  });

  test("one game, repeated games, ties and an ineligible opponent remain in matrix", () => {
    const input = { teams: teams("A", "B"), games: [game("ab", "A", "B", 1, 0)] };
    expect(computeColley(input).ratings.map(r => r.colleyRating)).toEqual([.625, .375]);
    expect(computeEligibility(input).get("B")?.eligible).toBe(false);
    const repeated = { ...input, games: [...input.games, game("ba", "A", "B", 0, 1), game("tie", "B", "A", 3, 3)] };
    for (const item of computeColley(repeated).ratings) expect(item.colleyRating).toBeCloseTo(.5, 14);
    expect(computeEligibility(repeated).get("A")?.record).toMatchObject({ wins: 1, losses: 1, ties: 1 });
  });

  test("three-team cycle and shuffled input preserve rank and rating", () => {
    const input = { teams: teams("C", "B", "A"), games: [game("a", "A", "B", 1, 0),
      game("b", "B", "C", 1, 0), game("c", "C", "A", 1, 0)] };
    const initial = computeColley(input).ratings;
    expect(initial.map(r => r.teamId)).toEqual(["A", "B", "C"]);
    initial.forEach(item => expect(item.colleyRating).toBeCloseTo(.5, 14));
    expect(computeColley({ teams: [...input.teams].reverse(), games: [...input.games].reverse() }).ratings).toEqual(initial);
  });

  test("thresholds use exact rational comparisons, including both sides of cutoffs", () => {
    const chain = (first: number, second: number) => [
      ...Array.from({ length: first }, (_, i) => game(`ab${i}`, "A", "B", 1, 0)),
      ...Array.from({ length: second }, (_, i) => game(`bc${i}`, "B", "C", 1, 0))];
    const ninety = computeColley({ teams: teams("A", "B", "C"), games: chain(8, 8) });
    expect(ninety.meetsThreshold("A", "0.90")).toBe(true);
    expect(ninety.meetsThreshold("B", "0.85")).toBe(false);
    expect(ninety.ratings[0]?.precisionMethod).toBe("cholesky+exact-comparison");
    const eightyFive = computeColley({ teams: teams("A", "B", "C"), games: chain(5, 4) });
    expect(eightyFive.meetsThreshold("A", "0.85")).toBe(true);
    expect(eightyFive.meetsThreshold("A", "0.90")).toBe(false);
    const below = computeColley({ teams: teams("A", "B", "C"), games: chain(7, 8) });
    expect(below.meetsThreshold("A", "0.90")).toBe(false);
  });

  test("FCS affects record only; schedules and postseason do not leak into either calculation", () => {
    const basis = { teams: teams("A", "B", "FCS"), games: [game("base", "A", "B", 1, 0)] };
    const extra = [game("fcs", "A", "FCS", 7, 0), game("scheduled", "A", "B", null, null,
      { status: "scheduled", completed: false }), game("ccg", "B", "A", 20, 0, { applicationGameType: "ccg" }),
      game("bowl", "B", "A", 20, 0, { applicationGameType: "bowl" }),
      game("cancel", "B", "A", null, null, { status: "cancelled", completed: false })];
    expect(computeColley({ ...basis, games: [...basis.games, ...extra] }).ratings).toEqual(computeColley(basis).ratings);
    expect(computeEligibility({ ...basis, games: [...basis.games, ...extra] }).get("A")?.record).toMatchObject({ wins: 2, losses: 0 });
    const fcsOnly = { teams: teams("A", "FCS"), games: [game("fcs", "A", "FCS", 7, 0)] };
    expect(computeEligibility(fcsOnly).get("A")?.eligible).toBe(true);
    expect(computeColley(fcsOnly).ratings[0]?.colleyRating).toBe(.5);
    expect(() => computeColley({ ...basis, games: [game("bad", "A", "B", null, 0)] })).toThrow();
    expect(() => computeEligibility({ ...basis, games: [game("bad", "A", "B", 0, 0,
      { status: "scheduled" })] })).toThrow();
  });

  test("numerical stress: disconnected schedule and heavily repeated results", () => {
    const ids = Array.from({ length: 24 }, (_, i) => `T${String(i).padStart(2, "0")}`);
    const games = Array.from({ length: 300 }, (_, i) => game(`g${i}`, ids[i % 12]!, ids[12 + (i % 12)]!, i % 3 ? 1 : 0, i % 3 ? 0 : 1));
    const result = computeColley({ teams: teams(...ids), games });
    expect(result.ratings).toHaveLength(ids.length);
    expect(result.ratings.reduce((sum, item) => sum + item.colleyRating, 0) / ids.length).toBeCloseTo(.5, 13);
    expect(Math.max(...result.ratings.map(item => item.residual))).toBeLessThan(1e-11);
  });
});

test("eligibility floor is exact with ties and excludes zero games", () => {
  for (const [wins, losses, ties, expected] of [[9, 3, 0, true], [8, 3, 0, false],
    [6, 2, 0, true], [3, 1, 0, true], [9, 4, 0, false], [0, 0, 0, false],
    [2, 1, 1, false], [2, 0, 2, true]] as const) {
    expect(recordIsEligible({ wins, losses, ties })).toBe(expected);
  }
});

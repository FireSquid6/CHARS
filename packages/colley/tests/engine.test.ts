import { describe, expect, test } from "bun:test";
import { analyzeScenarios, applyCategorySwaps, buildHeadToHead, buildPlayInsAndBracket, buildSnapshot, calculateColley, calculateRecords, calculateSelection, selectInitialField, seedSelectedTeams } from "../src/index";
import type { Game, Input } from "../src/index";

const stamp = (day: number) => `2025-11-${String(day).padStart(2, "0")}T00:00:00.000Z`;
function fixture(ids: string[], games: Game[] = []): Input {
  return { year: 2025, terminalCutoff: stamp(29), teams: ids.map(id => ({ id, name: id, fbs: id !== "FCS" })), games, polls: [{ id: "ap", year: 2025, week: 1, type: "AP", releasedAt: stamp(1), entries: ids.filter(id => id !== "FCS").map((teamId, i) => ({ teamId, rank: i + 1 })) }], membershipComplete: true, scheduleComplete: true, pollsComplete: true };
}
function game(id: string, home: string, away: string, score: [number, number] | null = [1, 0], day = 2): Game {
  return { id, year: 2025, week: day, home, away, kind: "regular", scheduledAt: stamp(day), completedAt: score ? stamp(day) : undefined, status: score ? "completed" : "scheduled", homeScore: score?.[0] ?? null, awayScore: score?.[1] ?? null };
}
const snap = (input: Input, day = 20) => buildSnapshot(input, stamp(day));

describe("Colley snapshot", () => {
  test("records include FCS and ties; zero games cannot qualify", () => {
    const records = calculateRecords(snap(fixture(["A", "B", "FCS", "C"], [game("1", "A", "FCS"), game("2", "A", "B", [0, 0])])));
    expect(records.find(r => r.teamId === "A")).toMatchObject({ wins: 1, ties: 1, gamesPlayed: 2, eligible: true });
    expect(records.find(r => r.teamId === "C")).toMatchObject({ gamesPlayed: 0, eligible: false });
    expect(records.find(r => r.teamId === "B")?.eligible).toBe(false);
  });
  test("exact .750 and 8-4 exclusion", () => {
    const games = Array.from({ length: 12 }, (_, i) => game(String(i), "A", "FCS", i < 8 ? [1, 0] : [0, 1]));
    expect(calculateRecords(snap(fixture(["A", "FCS"], games)))[0].eligible).toBe(false);
    const adjusted = games.map((g, i) => i === 8 ? { ...g, homeScore: 1, awayScore: 0 } : g);
    expect(calculateRecords(snap(fixture(["A", "FCS"], adjusted)))[0].eligible).toBe(true);
  });
  test("Colley fixtures and order independence", () => {
    const empty = calculateColley(snap(fixture(["B", "A"])));
    for (const e of empty.entries) expect(e.rating).toBeCloseTo(0.5, 12);
    expect(empty.entries.map(e => e.teamId)).toEqual(["A", "B"]);
    const single = calculateColley(snap(fixture(["B", "A"], [game("one", "A", "B")])));
    expect(single.entries[0].rating).toBeCloseTo(0.625, 12);
    expect(single.entries[1].rating).toBeCloseTo(0.375, 12);
    const games = [game("1", "A", "B"), game("2", "B", "C"), game("3", "C", "A")];
    const cycle = calculateColley(snap(fixture(["B", "C", "A"], games)));
    for (const e of cycle.entries) expect(e.rating).toBeCloseTo(0.5, 12);
    expect(calculateColley(snap(fixture(["A", "B", "C"], [...games].reverse()))).entries).toEqual(cycle.entries);
  });
  test("poll only tops up eligible teams; later games and polls isolated", () => {
    const input = fixture(["A", "B", "C", "D", "E", "FCS"], [game("1", "A", "FCS"), game("2", "B", "FCS"), game("3", "C", "FCS"), game("4", "D", "FCS"), game("5", "E", "FCS", null, 24)]);
    input.polls.push({ id: "cfp", type: "CFP", year: 2025, week: 10, releasedAt: stamp(25), entries: [{ teamId: "E", rank: 1 }] });
    const snapshot = snap(input);
    expect(snapshot.poll?.id).toBe("ap"); expect(snapshot.pollFallback).toBe(true);
    const field = selectInitialField(snapshot, calculateColley(snapshot));
    expect(field.bidCount).toBe(4);
    expect(field.entries.some(e => e.teamId === "E")).toBe(false);
    expect(snapshot.remaining.map(g => g.id)).toEqual(["5"]);
  });
  test("exact .90 rating qualifies for an inclusive bid", () => {
    const opponents = Array.from({ length: 12 }, (_, i) => `B${i}`);
    const games = opponents.map((id, i) => game(`g${i}`, "A", id));
    const snapshot = snap(fixture(["A", ...opponents], games));
    const ratings = calculateColley(snapshot);
    expect(ratings.atLeast("A", ".90")).toBe(true);
    expect(selectInitialField(snapshot, ratings).entries[0]).toMatchObject({ teamId: "A", category: "bid", route: "rating_bid" });
  });
  test("cyclic edges suppressed before selection, external edges survive", () => {
    const snapshot = snap(fixture(["A", "B", "C", "D"], [game("1", "A", "B"), game("2", "B", "C"), game("3", "C", "A"), game("4", "A", "D")]));
    const graph = buildHeadToHead(snapshot);
    expect(graph.cycles).toEqual([["A", "B", "C"]]);
    expect(graph.suppressed.length).toBe(3);
    expect(graph.active.map(e => `${e.winner}-${e.loser}`)).toEqual(["A-D"]);
  });
  test("overlapping cycles, split series and tied series never create internal overrides", () => {
    const games = [game("1", "A", "B"), game("2", "B", "C"), game("3", "C", "A"), game("4", "C", "D"), game("5", "D", "E"), game("6", "E", "C"), game("7", "A", "F"), game("8", "F", "A"), game("9", "B", "F", [0, 0]), game("10", "A", "G")];
    const graph = buildHeadToHead(snap(fixture(["A", "B", "C", "D", "E", "F", "G"], games)));
    expect(graph.cycles).toEqual([["A", "B", "C", "D", "E"]]);
    expect(graph.suppressed.length).toBe(6);
    expect(graph.active.map(e => `${e.winner}-${e.loser}`)).toEqual(["A-G"]);
  });
  test("swaps preserve boundaries and category sizes; outsider direct bid claim unapplied", () => {
    const ratings = calculateColley(snap(fixture(["A", "B", "C", "D"])));
    const initial = { entries: ["A", "B", "C", "D"].map((teamId, i) => ({ teamId, category: (i === 0 ? "bid" : i < 3 ? "playin" : "outside") as "bid" | "playin" | "outside", route: "outside" as const })), bidCount: 1, playinCount: 2, swaps: [], unapplied: [] };
    const graph = { raw: [], suppressed: [], cycles: [], active: [{ winner: "D", loser: "A", gameIds: ["1"] }, { winner: "D", loser: "C", gameIds: ["2"] }, { winner: "D", loser: "B", gameIds: ["3"] }, { winner: "B", loser: "A", gameIds: ["4"] }] };
    const final = applyCategorySwaps(initial, graph, ratings);
    expect(final.swaps.map(e => `${e.winner}-${e.loser}`)).toEqual(["B-A", "D-A", "D-B"]);
    expect(final.entries.map(e => e.category)).toEqual(["bid", "playin", "playin", "outside"]);
    const directOnly = applyCategorySwaps(initial, { ...graph, active: [graph.active[0]] }, ratings);
    expect(directOnly.unapplied.map(e => e.winner)).toEqual(["D"]);
    expect(seedSelectedTeams(final, graph, ratings).length).toBe(3);
  });
  test("bracket gives highest odd play-in a bye and fixed seed alternatives", () => {
    const entries = ["A", "B", "C", "D"].map((teamId, i) => ({ teamId, category: (i === 0 ? "bid" : "playin") as "bid" | "playin", route: "outside" as const }));
    const field = { entries, bidCount: 1, playinCount: 3, swaps: [], unapplied: [] };
    const seeds = entries.map((e, i) => ({ ...e, adjustedRank: i + 1, rawRank: i + 1, rating: 0.5 }));
    expect(buildPlayInsAndBracket(field, seeds)).toMatchObject({ playInBye: "B", pairs: [["C", "D"]], size: 4, slots: [{ alternatives: ["A"] }, { alternatives: ["B"] }, { alternatives: ["C", "D"] }] });
    expect(buildPlayInsAndBracket({ ...field, entries: [], bidCount: 0, playinCount: 0 }, [])).toMatchObject({ size: 0, firstRound: [] });
    const eight = Array.from({ length: 8 }, (_, i) => ({ teamId: `T${i + 1}`, category: "bid" as const, route: "rating_bid" as const }));
    const eightSeeds = eight.map((e, i) => ({ ...e, adjustedRank: i + 1, rawRank: i + 1, rating: 0.5 }));
    expect(buildPlayInsAndBracket({ entries: eight, bidCount: 8, playinCount: 0, swaps: [], unapplied: [] }, eightSeeds).firstRound).toEqual([[1, 8], [4, 5], [2, 7], [3, 6]]);
  });
  test("exhaustive statuses distinguish witnesses from proofs", () => {
    const input = fixture(["A", "B", "C", "FCS"], [game("a", "A", "FCS"), game("b", "B", "FCS", [0, 1]), game("c", "A", "B", null, 24)]);
    const snapshot = snap(input);
    const pending = analyzeScenarios(snapshot, undefined, undefined, { maxCompletions: 1 });
    expect(pending.exhausted).toBe(false);
    expect(pending.teams.find(t => t.teamId === "A")?.proofState).toBe("pending");
    const full = analyzeScenarios(snapshot);
    expect(full.exhausted).toBe(true);
    expect(full.teams.find(t => t.teamId === "C")).toMatchObject({ status: "eliminated", proofState: "proved" });
    expect(full.teams.find(t => t.teamId === "A")?.proofState).toBe("proved");
  });
  test("poll-dependent win-out witnesses prove needs-help without claiming full exhaustion", () => {
    const ids = Array.from({ length: 13 }, (_, i) => `T${String(i).padStart(2, "0")}`);
    const input = fixture([...ids, "FCS"], ids.map((id, i) => game(`g${i}`, id, "FCS")));
    const result = analyzeScenarios(snap(input), undefined, undefined, { maxCompletions: 2 });
    expect(result.exhausted).toBe(false);
    const proof = result.teams.find(t => t.teamId === "T12")!;
    expect(proof).toMatchObject({ status: "needs_help", proofState: "proved" });
    expect(proof.witnesses.winOutQualifies?.poll).not.toEqual(proof.witnesses.winOutFails?.poll);
  });
  test("duplicate conflicting game IDs are rejected", () => {
    expect(() => snap(fixture(["A", "B"], [game("1", "A", "B"), game("1", "B", "A")]))).toThrow();
  });
});

import { describe, expect, test } from "bun:test";
import { CALENDAR_POLICY_VERSION, MODEL_VERSION, POLICY_VERSION, colleyInputFingerprint,
  computeEligibility, computePlayoff, seedField, standardSeedOrder } from "../src/index";
import type { ColleyResult } from "../src/colley";
import type { Game, Snapshot, TeamSeason } from "../src/index";
import type { SelectionInput } from "../src/selection";

const season = 2026;
function game(id: string, winner: string, loser: string): Game {
  return { id, providerGameId: id, season, week: 1, homeTeamId: winner, awayTeamId: loser,
    homeScore: 1, awayScore: 0, status: "completed", completed: true, kickoffUtc: null,
    providerSeasonType: "regular", applicationGameType: "regular", classificationSource: "fixture",
    payloadHash: id, resultRevision: 1 };
}
function fixture(ratings: Record<string, number>, edges: [string, string][] = [],
  poll: string[] = []): SelectionInput {
  const ids = Object.keys(ratings);
  const teams: TeamSeason[] = [...ids.map(teamId => ({ teamId, season, membership: "fbs" as const,
    conference: null })), { teamId: "FCS", season, membership: "fcs", conference: null }];
  const games = [...edges.map(([winner, loser], i) => game(`edge-${i}`, winner, loser)),
    ...ids.flatMap(id => Array.from({ length: 12 }, (_, i) => game(`fcs-${id}-${i}`, id, "FCS")))];
  const compare = (a: string, b: string) => ratings[b]! - ratings[a]! || (a < b ? -1 : a > b ? 1 : 0);
  const result: ColleyResult = { inputFingerprint: colleyInputFingerprint({ season, teams, games }),
    ratings: [...ids].sort(compare).map((teamId, i) => ({ teamId, colleyRank: i + 1,
      colleyRating: ratings[teamId]!, residual: 0, errorBound: 0, precisionMethod: "fixture" })),
    compareTeamIds: compare, meetsThreshold: (id, threshold) => ratings[id]! >= Number(threshold) };
  return { season, teams, games, ratings: result,
    records: [...computeEligibility({ season, teams, games })].map(([teamId, { record }]) => ({ teamId, record })),
    pollEntries: poll.map((teamId, i) => ({ teamId, rank: i + 1 })) };
}

describe("adjusted seeding order", () => {
  test("rejects mismatched snapshot policy, model, calendar or season", () => {
    const input = fixture({ A: .95 });
    const snapshot = { key: "2026-final", season, revision: 1, inputHash: "fixture",
      policyVersion: POLICY_VERSION, modelVersion: MODEL_VERSION,
      calendarPolicyVersion: CALENDAR_POLICY_VERSION };
    for (const [field, error] of [
      ["policyVersion", /policyVersion/], ["modelVersion", /modelVersion/],
      ["calendarPolicyVersion", /calendarPolicyVersion/], ["season", /season/]
    ] as const) {
      expect(() => computePlayoff(input, { ...snapshot, [field]: field === "season" ? 2025 : "other" }))
        .toThrow(error);
    }
    expect(computePlayoff(input, snapshot).publicationStatus.state).toBe("provisional");
    expect(computePlayoff(input).publicationStatus.state).toBe("incomplete");
    const published: Snapshot = { ...snapshot, kind: "selection_final", week: 13,
      gameCutoffUtc: "2026-11-30T00:00:00Z", pollCutoffUtc: null, pollReleaseId: null,
      coverage: "unknown", publishedAtUtc: "2026-12-01T00:00:00Z" };
    const result = computePlayoff(input, published);
    expect(result.publicationStatus).toMatchObject({ state: "provisional" });
    expect(result.publicationStatus.reason).toContain("step 7");
  });

  test("real chain constraints override raw rank without changing final bid and play-in labels", () => {
    const input = fixture({ C: .97, D: .96, E: .95, F: .94, B: .87, A: .7 },
      [["A", "B"], ["B", "C"]]);
    const result = seedField(input);
    expect(result.selection.swaps.map(s => [s.winnerTeamId, s.loserTeamId])).toEqual([["B", "C"]]);
    expect(result.adjustedOrder.indexOf("A")).toBeLessThan(result.adjustedOrder.indexOf("B"));
    expect(result.adjustedOrder.indexOf("B")).toBeLessThan(result.adjustedOrder.indexOf("C"));
    expect(result.teams.find(t => t.teamId === "B")).toMatchObject({ colleyRank: 5, finalCategory: "bid" });
    expect(result.teams.find(t => t.teamId === "C")).toMatchObject({ colleyRank: 1, finalCategory: "playin" });
    expect(result.edges.map(e => e.reason)).toEqual(["head_to_head"]);
    expect(result.selection.graph.activeEdges).toHaveLength(2);
    expect(seedField({ ...input, teams: [...input.teams].reverse(), games: [...input.games].reverse() }))
      .toEqual(result);
    const fullChain = seedField(fixture({ A: .91, B: .92, C: .93 },
      [["A", "B"], ["B", "C"]]));
    expect(fullChain.adjustedOrder).toEqual(["A", "B", "C"]);
    expect(fullChain.edges).toHaveLength(2);
  });

  test("cycles use a Colley chain, retain external wins, and honor cycles through outsiders", () => {
    const input = fixture({ X: .99, C: .96, A: .95, D: .94, B: .93, Y: .88 },
      [["A", "B"], ["B", "C"], ["C", "A"], ["B", "Y"], ["Y", "X"]]);
    const r = seedField(input);
    expect(r.cyclicGroups).toEqual([["C", "A", "B"]]);
    expect(r.cycleEdges).toHaveLength(3);
    expect(r.edges.filter(e => e.reason === "cyclic_colley").map(e =>
      [e.beforeTeamId, e.afterTeamId])).toEqual([["A", "B"], ["C", "A"]]);
    for (const edge of r.edges) expect(r.adjustedOrder.indexOf(edge.beforeTeamId))
      .toBeLessThan(r.adjustedOrder.indexOf(edge.afterTeamId));
    expect(r.adjustedOrder.indexOf("B")).toBeLessThan(r.adjustedOrder.indexOf("Y"));
    expect(r.adjustedOrder.indexOf("Y")).toBeLessThan(r.adjustedOrder.indexOf("X"));

    const outsiderCycle = seedField(fixture({ A: .96, B: .95, C: .94, D: .93, P: .86, O: .7 },
      [["P", "O"], ["O", "D"], ["D", "P"]]));
    expect(outsiderCycle.selection.graph.cyclicComponents).toEqual([["D", "O", "P"]]);
    expect(outsiderCycle.selection.swaps).toEqual([]);
    expect(outsiderCycle.cyclicGroups).toEqual([["D", "P"]]);
  });

  test("zero-indegree choices always use the best Colley key; each emitted edge is respected", () => {
    const ids = Array.from({ length: 16 }, (_, i) => `T${String(i).padStart(2, "0")}`);
    const ratings = Object.fromEntries(ids.map((id, i) => [id, .96 - i * .004]));
    for (let salt = 0; salt < 12; salt++) {
      const edges: [string, string][] = [];
      for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) {
        if ((i * 13 + j * 7 + salt * 11) % 9 === 0) edges.push([ids[j]!, ids[i]!]);
      }
      const r = seedField(fixture(ratings, edges));
      const positions = new Map(r.adjustedOrder.map((id, i) => [id, i]));
      for (const edge of r.edges) expect(positions.get(edge.beforeTeamId)!).toBeLessThan(positions.get(edge.afterTeamId)!);
      expect(new Set(r.adjustedOrder).size).toBe(r.teams.length);
    }
  });
});

describe("fixed bracket", () => {
  test("odd play-in pool awards highest invite a bye; high-low pairs and fixed winner slots", () => {
    const r = computePlayoff(fixture({ A: .96, B: .95, C: .94, D: .93, P: .88, Q: .87,
      R: .86, S: .85, T: .84 }, [], ["T"]));
    expect(r.playinByeTeamId).toBe("P");
    expect(r.playinPairs.map(p => [p.teamAId, p.teamBId])).toEqual([["Q", "T"], ["R", "S"]]);
    expect(r.mainSlots).toHaveLength(7);
    for (const pair of r.playinPairs) {
      const slot = r.mainSlots.find(s => s.id === pair.winnerSlotId)!;
      expect(slot).toMatchObject({ teamAId: pair.teamAId, teamBId: pair.teamBId,
        teamId: null, source: "playin_winner", priorityAdjustedRank: pair.teamAAdjustedRank });
      expect(slot.label).toBe(`${pair.teamAId} / ${pair.teamBId}`);
    }
    expect(r.mainSlots.find(s => s.teamId === "P")?.source).toBe("playin_bye");
    expect(r.bracketSize).toBe(8);
    expect(r.rounds[0]?.filter(match => match.isBye)).toHaveLength(1);
    expect(r.shortFieldExplanation).toContain("no eligibility, poll, or parity invitations");
  });

  test("standard eight order, nine slots, and byes for highest seeds at every bracket size", () => {
    expect(standardSeedOrder(8)).toEqual([1, 8, 4, 5, 2, 7, 3, 6]);
    for (const count of [2, 3, 4, 5, 7, 8, 9, 15, 17]) {
      const ratings = Object.fromEntries(Array.from({ length: count }, (_, i) => [`T${i}`, .99 - i * .001]));
      const r = computePlayoff(fixture(ratings));
      expect(r.mainSlots).toHaveLength(count);
      expect(r.bracketSize).toBe(2 ** Math.ceil(Math.log2(count)));
      expect(r.rounds[0]?.filter(m => m.isBye).map(m =>
        r.mainSlots.find(s => s.id === (m.first as { slotId: string }).slotId)!.seed).sort((a, b) => a - b))
        .toEqual(Array.from({ length: r.bracketSize - count }, (_, i) => i + 1));
      expect(r.rounds.at(-1)).toHaveLength(1);
    }
  });

  test("empty, singleton and sub-four fields do not fabricate games or entrants", () => {
    const empty = computePlayoff(fixture({}));
    expect(empty.mainSlots).toEqual([]);
    expect(empty.rounds).toEqual([]);
    expect(empty.champion).toBeNull();
    const one = computePlayoff(fixture({ A: .95 }));
    expect(one.mainSlots).toHaveLength(1);
    expect(one.rounds).toEqual([]);
    expect(one.champion).toEqual({ kind: "slot", slotId: "main-slot-1" });
    const three = computePlayoff(fixture({ A: .95, B: .94, C: .93 }));
    expect(three.counts.bid).toBe(3);
    expect(three.rounds[0]?.filter(m => m.isBye)).toHaveLength(1);
  });

  test("all main slot IDs stay distinct for arbitrary team names including play-in pair identifiers", () => {
    const r = computePlayoff(fixture({ "playin-1": .98, "slot-playin-1": .97,
      "main-slot-1": .96, D: .95, E: .88, F: .87, G: .86, H: .85 }));
    expect(r.playinPairs).toHaveLength(2);
    expect(r.mainSlots).toHaveLength(6);
    expect(new Set(r.mainSlots.map(slot => slot.id)).size).toBe(r.mainSlots.length);
    expect(r.mainSlots.every(slot => !r.seeding.rankings.some(team => team.teamId === slot.id))).toBe(true);
    expect(r.mainSlots.every(slot => !r.playinPairs.some(pair => pair.id === slot.id))).toBe(true);
    expect(r.playinPairs.map(pair => pair.winnerSlotId)).toEqual(
      r.mainSlots.filter(slot => slot.source === "playin_winner").map(slot => slot.id));
    expect(r.mainSlots.find(slot => slot.teamId === "playin-1")?.id)
      .not.toBe(r.playinPairs[0]?.winnerSlotId);
    for (const match of r.rounds.flat()) for (const entry of [match.first, match.second]) {
      if (entry?.kind === "slot") expect(r.mainSlots.some(slot => slot.id === entry.slotId)).toBe(true);
    }
  });

  test("mixed bids and play-in winners use provisional adjusted priorities at eight and sixteen", () => {
    for (const playinCount of [8, 10]) {
      const ratings = Object.fromEntries(Array.from({ length: 4 + playinCount }, (_, i) =>
        [`T${String(i).padStart(2, "0")}`, i < 4 ? .99 - i * .01 : .89 - (i - 4) * .002]));
      const r = computePlayoff(fixture(ratings));
      expect(r.counts).toMatchObject({ bid: 4, playin: playinCount,
        mainSlots: 4 + playinCount / 2 });
      expect(r.bracketSize).toBe(playinCount === 8 ? 8 : 16);
      expect(r.mainSlots.map(slot => slot.priorityAdjustedRank))
        .toEqual(playinCount === 8 ? [1, 2, 3, 4, 5, 6, 7, 8] : [1, 2, 3, 4, 5, 6, 7, 8, 9]);
      for (const pair of r.playinPairs) {
        const slot = r.mainSlots.find(s => s.id === pair.winnerSlotId)!;
        expect(slot.seed).toBe(pair.teamAAdjustedRank);
        expect(slot.teamBId).toBe(pair.teamBId);
        expect(slot.teamId).toBeNull();
      }
      expect(r.rounds[0]?.filter(m => m.isBye)).toHaveLength(r.bracketSize - r.mainSlots.length);
    }
  });
});

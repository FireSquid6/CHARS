import { expect, test } from "bun:test";
import { computeScenarios, type Game, type ScenarioInput } from "../src/index";

function fixture(ids: string[], completed: Record<string, string[]>, future: [string, string][] = [],
  season = 2026): ScenarioInput {
  let counter = 0;
  const game = (home: string, away: string, scheduled = false): Game => {
    const id = `g${counter++}`;
    return { id, providerGameId: id, season, week: 1, homeTeamId: home, awayTeamId: away,
      homeScore: scheduled ? null : 1, awayScore: scheduled ? null : 0,
      status: scheduled ? "scheduled" : "completed", completed: !scheduled, kickoffUtc: null,
      providerSeasonType: "regular", applicationGameType: "regular", classificationSource: "test",
      payloadHash: id, resultRevision: 1 };
  };
  return { season, teams: [...ids.map(teamId => ({ season, teamId, membership: "fbs" as const,
    conference: null })), { season, teamId: "FCS", membership: "fcs", conference: null }],
  games: [...Object.entries(completed).flatMap(([id, opponents]) => opponents.map(opponent => game(id, opponent))),
    ...future.map(([home, away]) => game(home, away, true))],
  snapshot: { key: "snapshot", season, revision: 1, inputHash: "hash", policyVersion: "selection-v1",
    modelVersion: "colley-fbs-only-v1", calendarPolicyVersion: "pre-ccg-weekend-v1" } };
}
const proof = (input: ScenarioInput, id: string) => computeScenarios(input).proofs.find(p => p.teamId === id)!;

test("vacuous win-out, exhaustive clinched and eliminated certificates", () => {
  const input = fixture(["A", "B"], { A: ["FCS", "FCS", "FCS"], B: ["FCS", "FCS"] });
  // Reverse one completed result: B finishes 2-1 and cannot be polled into the field.
  input.games.push({ ...input.games[0]!, id: "loss", providerGameId: "loss", homeTeamId: "FCS", awayTeamId: "B" });
  const result = computeScenarios(input);
  expect(result.evaluatedCompletions).toBe(1);
  expect(result.proofs.find(p => p.teamId === "A")?.label).toBe("clinched");
  expect(result.proofs.find(p => p.teamId === "B")?.label).toBe("eliminated");
  expect(result.proofs.find(p => p.teamId === "A")?.witnesses.map(w => w.kind)).toContain("qualifying_win_out");
  expect(result.proofs.find(p => p.teamId === "B")?.witnesses.map(w => w.kind)).toContain("failing_win_out");
  expect(JSON.parse(result.proofs[0]!.proofMetadata!).certificate).toBe("exhaustive poll-equivalence classes");
});

test("current ineligibility recovers, and win-out controls destiny", () => {
  const input = fixture(["A", "B"], { A: ["FCS", "FCS"], B: ["FCS", "FCS"] }, [["A", "B"]]);
  expect(proof(input, "A").label).toBe("controls_destiny");
  expect(proof(input, "B").label).toBe("controls_destiny");
  expect(proof(input, "A").witnesses).toHaveLength(3);
});

test("shared FBS game has one result, FCS games change records but not FBS Colley", () => {
  const input = fixture(["A", "B"], { A: ["FCS", "FCS"], B: ["FCS", "FCS"] }, [["A", "B"]]);
  const result = computeScenarios(input);
  expect(result.evaluatedCompletions).toBe(2);
  expect(result.proofs.find(p => p.teamId === "A")?.witnesses.find(w => w.kind === "qualifying_win_out")?.gameOutcomes)
    .toEqual(result.proofs.find(p => p.teamId === "B")?.witnesses.find(w => w.kind === "failing")?.gameOutcomes);
  const againstFcs = fixture(["A"], { A: ["FCS", "FCS"] }, [["A", "FCS"]]);
  expect(proof(againstFcs, "A").label).toBe("controls_destiny");
});

test("even winning out cannot recover a 750 record", () => {
  const input = fixture(["A"], { A: ["FCS"] }, [["A", "FCS"]]);
  for (let i = 0; i < 3; i++) input.games.push({ ...input.games[0]!, id: `l${i}`, providerGameId: `l${i}`,
    homeTeamId: "FCS", awayTeamId: "A" });
  expect(proof(input, "A").label).toBe("eliminated");
});

test("poll-dependent needs help quantifies over all eligible poll orders, even with no games", () => {
  const ids = Array.from({ length: 13 }, (_, i) => `T${i}`);
  const input = fixture(ids, Object.fromEntries(ids.map(id => [id, ["FCS"]])));
  const result = computeScenarios(input);
  expect(result.evaluatedCompletions).toBe(9);
  const target = result.proofs.find(p => p.teamId === "T9")!;
  expect(target.label).toBe("needs_help");
  expect(JSON.parse(target.proofMetadata!).pollDependent).toBe(true);
  expect(target.witnesses.map(w => w.kind).sort()).toEqual([
    "failing", "failing_win_out", "qualifying", "qualifying_win_out"]);
  expect(target.witnesses.every(w => w.pollOrderTeamIds.length === 13)).toBe(true);
});

test("poll combinatorics and exhausted runtime remain pending, not a claimed label", () => {
  const ids = Array.from({ length: 30 }, (_, i) => `T${i}`);
  const input = fixture(ids, Object.fromEntries(ids.map(id => [id, ["FCS"]])));
  const result = computeScenarios(input);
  expect(result.pendingReason).toContain("cap");
  expect(result.proofs.every(p => p.state === "pending" && p.label === null)).toBe(true);
  expect(result.assumptions).toContain("all eligible poll orders; terminal eligible FBS teams only, up to 25 distinct entries");
  const timed = computeScenarios({ ...fixture(["A"], { A: ["FCS"] }), maxRuntimeMs: 0 });
  expect(timed.proofs[0]?.state).toBe("pending");
  const memory = computeScenarios({ ...fixture(["A", "B"],
    { A: ["FCS", "FCS"], B: ["FCS", "FCS"] }, [["A", "B"]]), maxTrackedPollPaths: 1 });
  expect(memory.pendingReason).toContain("memory budget");
  expect(memory.proofs.every(p => p.label === null)).toBe(true);
});

test("historical ties require an explicit pre-overtime option", () => {
  const modern = fixture(["A"], {}, [["A", "FCS"]]);
  expect(() => computeScenarios({ ...modern, allowHistoricalTies: true })).toThrow(/before 1996/);
  const old = fixture(["A"], {}, [["A", "FCS"]], 1995);
  expect(computeScenarios({ ...old, allowHistoricalTies: true }).evaluatedCompletions).toBe(3);
});

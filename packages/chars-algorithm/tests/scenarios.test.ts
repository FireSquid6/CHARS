import { expect, test } from "bun:test";
import { computeScenarios, type Game, type ScenarioInput } from "../src/index";

function fixture(ids: string[], completed: Record<string, string[]>, future: [string, string][] = [],
  season = 2026): ScenarioInput {
  let counter = 0;
  const game = (home: string, away: string, scheduled = false): Game => {
    const id = `g${counter++}`;
    return { id, providerGameId: id, season, week: 1, homeTeamId: home, awayTeamId: away,
      homeScore: scheduled ? null : 1, awayScore: scheduled ? null : 0,
      status: scheduled ? "scheduled" : "completed", completed: !scheduled,
      kickoffUtc: `${season}-${scheduled ? "11" : "09"}-01T12:00:00Z`,
      providerSeasonType: "regular", applicationGameType: "regular", classificationSource: "test",
      payloadHash: id, resultRevision: 1 };
  };
  return { season, teams: [...ids.map(teamId => ({ season, teamId, membership: "fbs" as const,
    conference: null })), { season, teamId: "FCS", membership: "fcs", conference: null }],
  games: [...Object.entries(completed).flatMap(([id, opponents]) => opponents.map(opponent => game(id, opponent))),
    ...future.map(([home, away]) => game(home, away, true))],
  gameCutoffUtc: `${season}-10-01T00:00:00Z`, selectionFreezeUtc: `${season}-12-01T00:00:00Z`,
  scheduleComplete: true,
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

test("record proof survives exponential schedules and budget zero, with provenance", () => {
  const ids = Array.from({ length: 32 }, (_, i) => `T${i}`);
  const input = fixture(ids, { T0: [] }, ids.slice(1).map(id => [id, "FCS"]));
  for (let i = 0; i < 10; i++) input.games.push({ ...input.games[0]!, id: `loss-${i}`,
    providerGameId: `loss-${i}`, homeTeamId: "FCS", awayTeamId: "T0",
    completed: true, status: "completed", homeScore: 1, awayScore: 0,
    kickoffUtc: "2026-09-01T12:00:00Z" });
  const result = computeScenarios({ ...input, maxRuntimeMs: 0, maxCompletions: 1 });
  const target = result.proofs.find(p => p.teamId === "T0")!;
  expect(target.label).toBe("eliminated");
  expect(JSON.parse(target.proofMetadata!).certificate).toBe("exact maximum terminal record below .750");
  expect(result.proofs.find(p => p.teamId === "T1")?.label).toBeNull();
  expect(computeScenarios({ ...input, scheduleComplete: false, maxRuntimeMs: 0 }).proofs
    .find(p => p.teamId === "T0")?.label).toBeNull();
});

test("deterministic completion cursor matches one-shot exhaustive proofs", () => {
  const input = fixture(["A", "B"], { A: ["FCS", "FCS"], B: ["FCS", "FCS"] }, [["A", "B"]]);
  const first = computeScenarios({ ...input, maxCompletions: 1 });
  expect(first.complete).toBe(false);
  expect(first.proofs.every(p => p.label === null)).toBe(true);
  const initialWitnesses = Object.fromEntries(first.proofs.map(p => [p.teamId, p.witnesses]));
  const second = computeScenarios({ ...input, startCompletion: first.nextCompletion,
    initialWitnesses, maxCompletions: 1 });
  expect(second.complete).toBe(true);
  expect(second.proofs.map(p => p.label)).toEqual(computeScenarios(input).proofs.map(p => p.label));
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
  expect(result.evaluatedCompletions).toBe(0);
  const incremental = computeScenarios({ ...input, startCompletion: 0, maxCompletions: 1 });
  expect(incremental.evaluatedCompletions).toBe(1);
  expect(incremental.proofs.every(p => p.label === null)).toBe(true);
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

test("unknown classification of a relevant pre-freeze game blocks even an apparent clinch", () => {
  const input = fixture(["A"], { A: ["FCS"] });
  const unknown = { ...input.games[0]!, id: "unknown", providerGameId: "unknown",
    applicationGameType: "unknown" as const, status: "scheduled" as const, completed: false,
    homeScore: null, awayScore: null, kickoffUtc: "2026-11-02T00:00:00Z" };
  input.games.push(unknown);
  const result = computeScenarios(input);
  expect(result.pendingReason).toContain("unknown");
  expect(result.proofs[0]?.state).toBe("pending");
  expect(result.proofs[0]?.label).toBeNull();
  const other = { ...unknown, id: "other", providerGameId: "other", applicationGameType: "regular" as const };
  const changed = { ...input, teams: input.teams.map(t => t.teamId === "FCS" ?
    { ...t, membership: "other" as const } : t), games: [input.games[0]!, other] };
  expect(computeScenarios(changed).pendingReason).toContain("membership");
  expect(computeScenarios({ ...input, games: [input.games[0]!,
    { ...unknown, awayTeamId: "UNRESOLVED" }] }).pendingReason).toContain("Unknown or wrong-season opponent");
  expect(computeScenarios({ ...input, scheduleComplete: false }).proofs[0]?.label).toBeNull();
});

test("exclude late regular games and require a known pre-freeze future kickoff", () => {
  const input = fixture(["A"], { A: ["FCS"] }, [["A", "FCS"]]);
  const future = input.games[1]!;
  const late = { ...future, kickoffUtc: "2026-12-02T00:00:00Z" };
  const result = computeScenarios({ ...input, games: [input.games[0]!, late] });
  expect(result.proofs[0]?.label).toBe("clinched");
  expect(result.evaluatedCompletions).toBe(1);
  expect(computeScenarios({ ...input, games: [input.games[0]!, { ...future, kickoffUtc: null }] })
    .pendingReason).toContain("kickoff");
  expect(computeScenarios({ ...input, gameCutoffUtc: "2026-11-02T00:00:00Z" })
    .proofs[0]?.state).toBe("pending");
});

test("validate then discard irrelevant FCS-FCS games before the exponential cap", () => {
  const input = fixture(["A"], { A: ["FCS"] });
  input.teams.push({ season: 2026, teamId: "FCS2", membership: "fcs", conference: null });
  for (let i = 0; i < 20; i++) input.games.push({ ...input.games[0]!, id: `irrelevant-${i}`,
    providerGameId: `irrelevant-${i}`, homeTeamId: "FCS", awayTeamId: "FCS2",
    status: "scheduled", completed: false, homeScore: null, awayScore: null,
    kickoffUtc: "2026-11-05T00:00:00Z" });
  expect(computeScenarios(input).evaluatedCompletions).toBe(1);
  input.games.push({ ...input.games.at(-1)!, id: "duplicate", providerGameId: "irrelevant-0" });
  expect(() => computeScenarios(input)).toThrow(/Duplicate\/empty provider game ID/);
});

test("bounded exhaustive search has no constructible four-label coverage exception", () => {
  // Every 3-team, 2-game opponent schedule on this eligible baseline is checked.
  // No qualifying-only-outside-win-out witness exists in this family. The
  // unsupported/null branch remains intentionally unforced and lacks a fixture;
  // larger head-to-head/poll universes may still expose the policy exception.
  const opponents = ["A", "B", "C", "FCS"];
  let searched = 0;
  for (const first of opponents) for (const second of opponents) {
    const input = fixture(["A", "B", "C"], { A: ["FCS"], B: ["FCS"], C: ["FCS"] },
      [["A", first], ["B", second]]);
    if (first === "A" || second === "B") continue;
    const result = computeScenarios(input);
    expect(result.proofs.every(p => p.state !== "unsupported")).toBe(true);
    searched++;
  }
  expect(searched).toBe(9);
});

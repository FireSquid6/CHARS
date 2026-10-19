/** Synthetic workload only: run `bun packages/chars-algorithm/tests/scenarios.benchmark.ts`. */
import { computeScenarios, type Game, type ScenarioInput } from "../src/index";

const season = 2026;
const ids = Array.from({ length: 134 }, (_, i) => `T${String(i).padStart(3, "0")}`);
const games: Game[] = [];
for (let round = 0; round < 12; round++) for (let i = 0; i < ids.length; i += 2) {
  const future = round >= 4;
  const id = `r${round}-${i}`;
  games.push({ id, providerGameId: id, season, week: round, homeTeamId: ids[i]!,
    awayTeamId: ids[(i + 1 + 2 * round) % ids.length]!,
    kickoffUtc: future ? "2026-11-01T12:00:00Z" : "2026-09-01T12:00:00Z",
    homeScore: future ? null : i % 4 === 0 ? 1 : 0,
    awayScore: future ? null : i % 4 === 0 ? 0 : 1,
    status: future ? "scheduled" : "completed", completed: !future,
    providerSeasonType: "regular", applicationGameType: "regular", classificationSource: "synthetic",
    payloadHash: id, resultRevision: 1 });
}
const input: ScenarioInput = { season, teams: ids.map(teamId => ({ teamId, season, membership: "fbs",
  conference: null })), games, scheduleComplete: true,
  gameCutoffUtc: "2026-10-01T00:00:00Z", selectionFreezeUtc: "2026-12-01T00:00:00Z",
  snapshot: { key: "synthetic", season, revision: 1, inputHash: "synthetic", policyVersion: "selection-v1",
    modelVersion: "colley-fbs-only-v1", calendarPolicyVersion: "pre-ccg-weekend-v1" },
  maxCompletions: 1, maxRuntimeMs: 2000 };
const start = performance.now();
const result = computeScenarios(input);
console.log(JSON.stringify({ teams: ids.length, games: games.length, futureGames: games.filter(g => !g.completed).length,
  elapsedMs: Math.round(performance.now() - start), evaluated: result.evaluatedCompletions,
  proved: result.proofs.filter(p => p.state === "proved").length,
  pending: result.proofs.filter(p => p.state === "pending").length,
  reason: result.pendingReason }));

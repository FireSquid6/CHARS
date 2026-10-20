/** Offline synthetic full-season workload: bun packages/chars-algorithm/tests/scenarios.benchmark.ts */
import { computeScenarios, type Game, type ScenarioInput } from "../src/index";

const season = 2026;
const ids = Array.from({ length: 134 }, (_, i) => `T${String(i).padStart(3, "0")}`);
// Circle-method schedule: twelve distinct FBS opponents per team, one shared
// result per game, 804 games total; no real-season coverage is implied.
const rotation = [...ids];
const schedule: Array<{ home: string; away: string; round: number; index: number }> = [];
for (let round = 0; round < 12; round++) {
  for (let i = 0; i < 67; i++) schedule.push({ home: rotation[i]!, away: rotation[133 - i]!, round, index: i });
  rotation.splice(1, 0, rotation.pop()!);
}
for (const completedRounds of [0, 4, 8, 11]) {
  const games: Game[] = schedule.map(({ home, away, round, index }) => {
    const id = `r${round}-${index}`, future = round >= completedRounds;
    const homeWins = (index * 37 + round * 71 + index * round * 13) % 11 < 6;
    return { id, providerGameId: id, season, week: round, homeTeamId: home, awayTeamId: away,
      kickoffUtc: future ? "2026-11-01T12:00:00Z" : "2026-09-01T12:00:00Z",
      homeScore: future ? null : Number(homeWins), awayScore: future ? null : Number(!homeWins),
      status: future ? "scheduled" : "completed", completed: !future,
      providerSeasonType: "regular", applicationGameType: "regular", classificationSource: "synthetic",
      payloadHash: id, resultRevision: 1 };
  });
  const input: ScenarioInput = { season, teams: ids.map(teamId => ({ teamId, season, membership: "fbs",
    conference: null })), games, scheduleComplete: true,
    gameCutoffUtc: "2026-10-01T00:00:00Z", selectionFreezeUtc: "2026-12-01T00:00:00Z",
    snapshot: { key: `synthetic-${completedRounds}`, season, revision: 1, inputHash: `synthetic-${completedRounds}`,
      policyVersion: "selection-v1", modelVersion: "colley-fbs-only-v1",
      calendarPolicyVersion: "pre-ccg-weekend-v1" },
    maxCompletions: 1, maxRuntimeMs: 2000 };
  const start = performance.now();
  const result = computeScenarios(input);
  const labels = Object.fromEntries(["clinched", "eliminated", "controls_destiny", "needs_help"]
    .map(label => [label, result.proofs.filter(p => p.label === label).length]));
  console.log(JSON.stringify({ teams: ids.length, games: games.length, completedRounds,
    futureGames: games.filter(g => !g.completed).length,
    elapsedMs: Math.round(performance.now() - start), evaluated: result.evaluatedCompletions,
    labels, pending: result.proofs.filter(p => p.state === "pending").length,
    unsupported: result.proofs.filter(p => p.state === "unsupported").length,
    reason: result.pendingReason }));
}

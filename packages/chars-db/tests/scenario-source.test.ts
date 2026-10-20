import { expect, test } from "bun:test";
import type { Game } from "../../chars-algorithm/src/index";
import { computeScenarios } from "../../chars-algorithm/src/index";
import { scenarioCoverageReady, scenarioRevisionKey, verifySnapshotSource } from "../src/scenarios";
import type { SeasonSource } from "../src/repository";
import { buildSnapshots } from "../src/snapshots";

const season = 2024;
function game(id: string, week: number, kickoffUtc: string, completed: boolean): Game {
  return { id, providerGameId: id, season, week, homeTeamId: "A", awayTeamId: "B", kickoffUtc,
    homeScore: completed ? 1 : null, awayScore: completed ? 0 : null,
    completed, status: completed ? "completed" : "scheduled", applicationGameType: "regular",
    classificationSource: "fixture", providerSeasonType: "regular", payloadHash: id, resultRevision: 1 };
}

test("score correction under a published cutoff forbids proofs until snapshot rebuild", () => {
  const source: SeasonSource = {
    season, teams: ["A", "B"].map(teamId => ({ season, teamId, membership: "fbs", conference: null })),
    games: [game("first", 1, "2024-09-01T12:00:00.000Z", true),
      game("future", 2, "2024-09-08T12:00:00.000Z", false)],
    polls: [{ release: { id: "cfp-1", season, type: "cfp", gameWeek: 1,
      releasedAtUtc: "2024-09-02T12:00:00.000Z", effectiveAtUtc: null, sourceHash: "cfp" },
    entries: [{ releaseId: "cfp-1", teamId: "A", rank: 1, points: null }] }], coverage: []
  };
  const calendar = { freezeUtc: "2024-09-15T12:00:00.000Z", verified: true };
  const published = buildSnapshots(source, calendar)[0]!;
  expect(() => verifySnapshotSource(published, source, calendar)).not.toThrow();
  const corrected: SeasonSource = { ...source, games: [{ ...source.games[0]!, homeScore: 0, awayScore: 1,
    resultRevision: 2 }, source.games[1]!] };
  expect(() => verifySnapshotSource(published, corrected, calendar)).toThrow(/rebuild before scenario proofs/);
  // Later real-world scores are NOT frozen at this week's cutoff. Their raw
  // revision still changes the cache identity, so old results cannot be read.
  const later: SeasonSource = { ...source, games: [source.games[0]!,
    { ...source.games[1]!, completed: true, status: "completed", homeScore: 0, awayScore: 1,
      resultRevision: 2 }] };
  expect(() => verifySnapshotSource(published, later, calendar)).not.toThrow();
  expect(scenarioRevisionKey(published, source, calendar)).not.toBe(scenarioRevisionKey(published, later, calendar));
});

test("derived current-poll timing does not block all-eligible future poll proofs", () => {
  const source: SeasonSource = { season, teams: ["A", "B"].map(teamId => ({
    season, teamId, membership: "fbs", conference: null })),
  games: [game("first", 1, "2024-09-01T12:00:00.000Z", true),
    game("future", 2, "2024-09-08T12:00:00.000Z", false)],
  polls: [{ release: { id: "cfp-1", season, type: "cfp", gameWeek: 1,
    releasedAtUtc: "2024-09-02T12:00:00.000Z", effectiveAtUtc: null, sourceHash: "cfp" },
  entries: [{ releaseId: "cfp-1", teamId: "A", rank: 1, points: null }] }], coverage: [] };
  const calendar = { freezeUtc: "2024-09-15T12:00:00.000Z", verified: true };
  const snapshot = buildSnapshots(source, calendar, "2024-09-08T12:00:00.000Z")[0]!;
  expect(snapshot.coverage).toEqual([
    "Poll publication timing is a derived upper bound, not an independently verified release"
  ]);
  expect(scenarioCoverageReady(snapshot.coverage)).toBe(true);
  expect(scenarioCoverageReady([...snapshot.coverage, "missing season schedule"])).toBe(false);
  expect(scenarioCoverageReady(["CFP poll absent at declared cutoff"])).toBe(false);
  expect(scenarioCoverageReady(["Partial-week results omitted: historical completion observations unavailable"])).toBe(false);
  const result = computeScenarios({ season, teams: source.teams, games: source.games,
    snapshot: { key: snapshot.key, season, revision: 0, inputHash: snapshot.sourceHash,
      policyVersion: snapshot.policyVersion, modelVersion: snapshot.modelVersion,
      calendarPolicyVersion: snapshot.calendarPolicyVersion },
    scheduleComplete: calendar.verified && scenarioCoverageReady(snapshot.coverage),
    gameCutoffUtc: snapshot.gameCutoffUtc, selectionFreezeUtc: calendar.freezeUtc });
  expect(result.proofs.find(proof => proof.teamId === "A")?.label).toBe("controls_destiny");
});

test("partial snapshot rebuild uses its original as-of cutoff", () => {
  const source: SeasonSource = { season, teams: ["A", "B"].map(teamId => ({
    season, teamId, membership: "fbs", conference: null })),
  games: [game("first", 1, "2024-09-01T12:00:00.000Z", true),
    game("future", 2, "2024-09-08T12:00:00.000Z", false)], polls: [], coverage: [] };
  const calendar = { freezeUtc: "2024-09-15T12:00:00.000Z", verified: true };
  const partial = buildSnapshots(source, calendar, "2024-09-04T12:00:00.000Z").find(item => item.kind === "partial")!;
  expect(partial.gameCutoffUtc).toBe("2024-09-04T12:00:00.000Z");
  expect(() => verifySnapshotSource(partial, source, calendar)).not.toThrow();
  expect(scenarioCoverageReady(partial.coverage)).toBe(false);
  expect(buildSnapshots(source, calendar, "2024-09-10T12:00:00.000Z")
    .some(item => item.key === partial.key)).toBe(false);
});

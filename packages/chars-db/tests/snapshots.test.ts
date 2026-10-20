import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readSeason, type SeasonSource, type SourceGameMetadata } from "../src/repository";
import { buildSnapshots, pollFingerprint, publishSnapshots, readPublished } from "../src/snapshots";

function fixture() {
  const db = new Database(":memory:");
  db.exec("CREATE TABLE seasons (team_id TEXT, year INTEGER, classification TEXT, conference_id TEXT); CREATE TABLE games (game_id INTEGER, home_team TEXT, away_team TEXT, year INTEGER, week INTEGER, start_date INTEGER, home_score INTEGER, away_score INTEGER); CREATE TABLE poll_releases (release_id TEXT, poll_id TEXT, year INTEGER, week INTEGER, released_at INTEGER); CREATE TABLE poll_entries (release_id TEXT, team_id TEXT, rank INTEGER)");
  db.exec("INSERT INTO seasons VALUES ('A',2024,'FBS','X'),('B',2024,'FBS','X'); INSERT INTO games VALUES (1,'A','B',2024,1,1725148800000,10,3),(2,'B','A',2024,2,1725753600000,NULL,NULL); INSERT INTO poll_releases VALUES ('ap1','ap',2024,1,1725321600000),('cfp2','cfp',2024,2,1725926400000); INSERT INTO poll_entries VALUES ('ap1','A',1),('cfp2','B',1)");
  const metadata: Record<string, SourceGameMetadata> = {
    "1": { providerSeasonType: "regular", applicationGameType: "regular", classificationSource: "fixture", status: "completed", completed: true, payloadHash: "h1" },
    "2": { providerSeasonType: "regular", applicationGameType: "regular", classificationSource: "fixture", status: "scheduled", completed: false, payloadHash: "h2" }
  };
  return { db, metadata };
}

test("weekly results and polls never read subsequent weeks; final needs verified calendar and coverage", () => {
  const { db, metadata } = fixture();
  try {
    const base = readSeason(db, 2024, metadata);
    const first = buildSnapshots(base)[0]!;
    expect(first.week).toBe(1);
    expect(first.includedGameIds).toEqual(["1"]);
    expect(first.pollReleaseId).toBe("ap1");
    expect(first.pollPolicy).toBe("ap-provisional-fallback");
    const lateAp = base.polls.find(poll => poll.release.id === "ap1")!;
    const correctedTiming = { ...base, pollTiming: { ap1: { reviewedBy: "fixture-reviewer",
      reviewedAtUtc: "2024-09-17T00:00:00.000Z", source: "fixture-publication-record",
      releasedAtUtc: "2024-09-09T00:00:00.000Z", pollFingerprint: pollFingerprint(lateAp) } } };
    expect(buildSnapshots(correctedTiming)[0]?.pollReleaseId).toBeNull();
    const legacyWeek = buildSnapshots(readSeason(db, 2024))[0]!;
    expect(legacyWeek.includedGameIds).toEqual([]);
    expect(legacyWeek.coverage).toContain("game 1: completion/classification unverified");
    expect(buildSnapshots(base).some(snapshot => snapshot.kind === "selection_final")).toBe(false);
    expect(buildSnapshots(base, { freezeUtc: "2024-09-14T00:00:00.000Z", firstCcgUtc: "2024-09-15T00:00:00.000Z", verified: true })
      .some(snapshot => snapshot.kind === "selection_final")).toBe(false);
    db.exec("UPDATE games SET home_score = 24, away_score = 0 WHERE game_id = 2");
    metadata["2"] = { ...metadata["2"]!, status: "completed", completed: true };
    db.exec("INSERT INTO games VALUES (3,'A','B',2024,3,1726358400000,0,40)");
    db.exec("INSERT INTO poll_releases VALUES ('cfp-later','cfp',2024,2,1726444800000)");
    db.exec("INSERT INTO poll_entries VALUES ('cfp-later','A',1)");
    metadata["3"] = { providerSeasonType: "postseason", applicationGameType: "ccg", classificationSource: "fixture", status: "completed", completed: true, payloadHash: "h3" };
    const later = readSeason(db, 2024, metadata);
    const updatedFirst = buildSnapshots(later)[0]!;
    expect(updatedFirst.includedGameIds).toEqual(first.includedGameIds);
    expect(updatedFirst.rankings).toEqual(first.rankings);
    expect(updatedFirst.key).toBe(first.key);
    expect(updatedFirst.pollReleaseId).toBe(first.pollReleaseId);
    const calendar = { freezeUtc: "2024-09-09T00:00:00.000Z", firstCcgUtc: "2024-09-15T00:00:00.000Z", verified: true };
    expect(buildSnapshots(later, calendar).some(snapshot => snapshot.kind === "selection_final")).toBe(false);
    const reviewedPoll = later.polls.find(poll => poll.release.id === "cfp2")!;
    later.pollTiming = { cfp2: { reviewedBy: "fixture-reviewer", source: "fixture-independent-publication-record",
      reviewedAtUtc: "2024-09-17T00:00:00.000Z", releasedAtUtc: "2024-09-10T00:00:00.000Z",
      pollFingerprint: pollFingerprint(reviewedPoll) } };
    const final = buildSnapshots(later, calendar)
      .find(snapshot => snapshot.kind === "selection_final");
    expect(final?.includedGameIds).toEqual(["1", "2"]);
    expect(final?.pollReleaseId).toBe("cfp2");
    later.pollTiming!.cfp2 = { ...later.pollTiming!.cfp2!, releasedAtUtc: "2024-09-15T12:00:00.000Z" };
    expect(buildSnapshots(later, calendar).some(snapshot => snapshot.kind === "selection_final")).toBe(false);
    later.pollTiming!.cfp2 = { ...later.pollTiming!.cfp2!, releasedAtUtc: undefined,
      interval: { earliestUtc: "2024-09-10T00:00:00.000Z", latestUtc: "2024-09-16T00:00:00.000Z" } };
    expect(buildSnapshots(later, calendar).some(snapshot => snapshot.kind === "selection_final")).toBe(false);
    later.pollTiming!.cfp2 = { ...later.pollTiming!.cfp2!, interval: undefined, releasedAtUtc: "2024-09-10T00:00:00.000Z",
      pollFingerprint: "0".repeat(64) };
    expect(buildSnapshots(later, calendar).some(snapshot => snapshot.kind === "selection_final")).toBe(false);
    expect(buildSnapshots(readSeason(db, 2024), { freezeUtc: "2024-09-09T00:00:00.000Z", firstCcgUtc: "2024-09-15T00:00:00.000Z", verified: true })
      .some(snapshot => snapshot.kind === "selection_final")).toBe(false);
    expect(buildSnapshots(later, { freezeUtc: "2024-09-14T00:00:00.000Z", firstCcgUtc: "2024-09-15T00:00:00.000Z", verified: true })
      .some(snapshot => snapshot.kind === "selection_final")).toBe(false);
  } finally { db.close(); }
});

test("failed publication keeps previously published manifest and artifacts", async () => {
  const { db, metadata } = fixture();
  const directory = await mkdtemp(join(tmpdir(), "chars-snapshots-"));
  try {
    const snapshots = buildSnapshots(readSeason(db, 2024, metadata));
    await publishSnapshots(directory, 2024, snapshots);
    const previous = await readPublished(directory, 2024);
    await expect(publishSnapshots(directory, 2024, [snapshots[0]!, { ...snapshots[1]!, key: "../../invalid" }])).rejects.toThrow();
    expect(await readPublished(directory, 2024)).toEqual(previous);
  } finally { db.close(); await rm(directory, { recursive: true, force: true }); }
});

test("stale weekly poll warning uses reviewed publication time instead of a later derived bound", () => {
  const { db, metadata } = fixture();
  try {
    const source = readSeason(db, 2024, metadata);
    const poll = source.polls.find(row => row.release.id === "ap1")!;
    const weekly: SeasonSource = { ...source,
      games: source.games.map(game => game.id === "1" ? { ...game, kickoffUtc: "2024-09-03T00:00:00.000Z" } :
        game.id === "2" ? { ...game, kickoffUtc: "2024-09-11T00:00:00.000Z" } : game),
      polls: source.polls.map(row => row.release.id === "ap1" ? { ...row,
        release: { ...row.release, releasedAtUtc: "2024-09-09T00:00:00.000Z" } } : row) };
    const warning = "No poll release following all included games; selection uses an earlier available poll";
    const derived = buildSnapshots(weekly)[0]!;
    expect(derived.gameCutoffUtc).toBe("2024-09-11T00:00:00.000Z");
    expect(derived.pollReleaseId).toBe("ap1");
    expect(derived.coverage).not.toContain(warning);
    weekly.pollTiming = { ap1: { reviewedBy: "fixture-reviewer", source: "independent fixture publication record",
      reviewedAtUtc: "2024-09-12T00:00:00.000Z", releasedAtUtc: "2024-09-02T00:00:00.000Z",
      pollFingerprint: pollFingerprint(poll) } };
    const reviewed = buildSnapshots(weekly)[0]!;
    expect(reviewed.pollReleaseId).toBe("ap1");
    expect(reviewed.includedGameIds).toEqual(["1"]);
    expect(reviewed.coverage).toContain(warning);
  } finally { db.close(); }
});

test("active season publishes preseason and partial weeks, never future week scores or polls", () => {
  const { db, metadata } = fixture();
  try {
    const source = readSeason(db, 2024, metadata);
    const before = buildSnapshots(source, {}, "2024-08-31T12:00:00.000Z");
    expect(before.map(snapshot => snapshot.kind)).toEqual(["partial"]);
    expect(before[0]?.week).toBeNull();
    expect(before[0]?.includedGameIds).toEqual([]);
    expect(before[0]?.playoff.counts.selected).toBe(0);
    expect(before[0]?.pollReleaseId).toBeNull();
    const emptySchedule = buildSnapshots({ ...source, games: [], polls: [], coverage: ["missing season schedule"] }, {},
      "2024-08-31T12:00:00.000Z");
    expect(emptySchedule.map(snapshot => snapshot.kind)).toEqual(["partial"]);
    expect(emptySchedule[0]?.playoff.counts.selected).toBe(0);
    const duringFirst = buildSnapshots(source, {}, "2024-09-01T12:00:00.000Z");
    expect(duringFirst.map(snapshot => snapshot.kind)).toEqual(["partial"]);
    expect(duringFirst[0]?.week).toBe(1);
    expect(duringFirst[0]?.includedGameIds).toEqual([]);
    expect(duringFirst[0]?.coverage).toContain("Partial-week results omitted: historical completion observations unavailable");
    expect(duringFirst[0]?.pollReleaseId).toBeNull();
    db.exec("UPDATE games SET home_score = 50, away_score = 0 WHERE game_id = 2");
    metadata["2"] = { ...metadata["2"]!, completed: true, status: "completed" };
    const later = readSeason(db, 2024, metadata);
    const middle = buildSnapshots(later, {}, "2024-09-08T12:00:00.000Z");
    expect(middle.map(snapshot => snapshot.kind)).toEqual(["week_final", "partial"]);
    expect(middle.at(-1)?.week).toBe(2);
    expect(middle.at(-1)?.includedGameIds).toEqual(["1"]);
    expect(middle.at(-1)?.pollReleaseId).toBe("ap1");
    const calendar = { freezeUtc: "2024-09-09T00:00:00.000Z", firstCcgUtc: "2024-09-15T00:00:00.000Z", verified: true };
    expect(buildSnapshots(later, calendar, "2024-09-10T00:00:00.000Z").some(snapshot => snapshot.kind === "selection_final")).toBe(false);
    later.pollTiming = { cfp2: { reviewedBy: "fixture-reviewer", source: "fixture-source", reviewedAtUtc: "2024-09-16T00:00:00.000Z",
      releasedAtUtc: "2024-09-10T00:00:00.000Z", pollFingerprint: pollFingerprint(later.polls.find(poll => poll.release.id === "cfp2")!) } };
    expect(buildSnapshots(later, calendar, "2024-09-16T00:00:00.000Z").some(snapshot => snapshot.kind === "selection_final")).toBe(true);
  } finally { db.close(); }
});

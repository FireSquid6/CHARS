import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readSeason, type SourceGameMetadata } from "../src/repository";
import { buildSnapshots, publishSnapshots, readPublished } from "../src/snapshots";

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
    const final = buildSnapshots(later, { freezeUtc: "2024-09-09T00:00:00.000Z", firstCcgUtc: "2024-09-15T00:00:00.000Z", verified: true })
      .find(snapshot => snapshot.kind === "selection_final");
    expect(final?.includedGameIds).toEqual(["1", "2"]);
    expect(final?.pollReleaseId).toBe("cfp2");
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

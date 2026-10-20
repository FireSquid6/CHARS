import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDatabase } from "../src/database";
import { migrateDatabase } from "../src/migrate";
import { conferences, games, pollEntries, pollReleases, seasons, teams } from "../src/schema";

let directory: string;
let connection: ReturnType<typeof openDatabase>;
const startDate = new Date("2026-09-05T19:30:00.123Z");

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "chars-db-"));
  const path = join(directory, "test.sqlite");
  migrateDatabase(path);
  migrateDatabase(path); // Reapplying migrations must be harmless.
  connection = openDatabase(path);
  connection.db.insert(teams).values([
    { teamId: "home", teamName: "Home", abbreviation: "H" },
    { teamId: "away", teamName: "Away", abbreviation: "A" },
  ]).run();
  connection.db.insert(conferences).values({
    conferenceId: "conference", name: "Conference", abbreviation: "C",
  }).run();
});

afterEach(() => {
  connection?.close();
  rmSync(directory, { recursive: true, force: true });
});

test("stores season membership with a composite key and nullable division", () => {
  const season = { teamId: "home", year: 2026, conferenceId: "conference", classification: "FBS" as const };
  connection.db.insert(seasons).values(season).run();
  expect(connection.db.select().from(seasons).get()).toEqual({ ...season, division: null });
  expect(() => connection.db.insert(seasons).values(season).run()).toThrow();
  connection.db.insert(seasons).values({ ...season, year: 2025 }).run();
  expect(() => connection.sqlite.exec(`INSERT INTO seasons VALUES ('away', 2026, 'conference', NULL, 'INVALID')`)).toThrow();
  expect(() => connection.db.insert(seasons).values({ ...season, teamId: "missing" }).run()).toThrow();
  expect(() => connection.db.insert(seasons).values({ ...season, year: 2024, conferenceId: "missing" }).run()).toThrow();
});

test("round-trips dates, incomplete games, and tied results", () => {
  const game = { gameId: 1, homeTeam: "home", awayTeam: "away", year: 2026, week: 0, startDate };
  connection.db.insert(games).values(game).run();
  expect(connection.db.select().from(games).get()).toEqual({ ...game, homeScore: null, awayScore: null, overtimes: null });
  connection.db.insert(games).values({ ...game, gameId: 2, homeScore: 7, awayScore: 7, overtimes: 0 }).run();
  expect(connection.db.select().from(games).all()).toHaveLength(2);
  expect(() => connection.db.insert(games).values(game).run()).toThrow();
  expect(() => connection.db.insert(games).values({ ...game, gameId: 3, homeTeam: "missing" }).run()).toThrow();
  expect(() => connection.db.insert(games).values({ ...game, gameId: 3, awayTeam: "missing" }).run()).toThrow();
  expect(() => connection.db.insert(games).values({ ...game, gameId: 3, awayTeam: "home" }).run()).toThrow();
  for (const field of ["homeScore", "awayScore", "overtimes"] as const) {
    expect(() => connection.db.insert(games).values({ ...game, gameId: 3, [field]: -1 }).run()).toThrow();
  }
});

test("poll entries enforce references and composite keys but allow tied ranks", () => {
  const release = { releaseId: "ap-2026-1", pollId: "AP", year: 2026, week: 1, releasedAt: startDate };
  connection.db.insert(pollReleases).values(release).run();
  expect(connection.db.select().from(pollReleases).get()).toEqual(release);
  const entry = { releaseId: release.releaseId, teamId: "home", rank: 1 };
  connection.db.insert(pollEntries).values([entry, { ...entry, teamId: "away" }]).run();
  expect(() => connection.db.insert(pollEntries).values(entry).run()).toThrow();
  expect(() => connection.db.insert(pollEntries).values({ ...entry, releaseId: "missing" }).run()).toThrow();
  expect(() => connection.db.insert(pollEntries).values({ ...entry, teamId: "missing" }).run()).toThrow();
  connection.db.insert(pollReleases).values({ ...release, releaseId: "second" }).run();
  expect(() => connection.db.insert(pollEntries).values({ ...entry, releaseId: "second", rank: 0 }).run()).toThrow();
});

test("transactions roll back atomically", () => {
  expect(() => connection.db.transaction((tx) => {
    tx.insert(teams).values({ teamId: "new", teamName: "New", abbreviation: "N" }).run();
    throw new Error("abort");
  })).toThrow("abort");
  expect(connection.db.select().from(teams).all()).toHaveLength(2);
});

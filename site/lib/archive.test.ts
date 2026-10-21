import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { getSchedule, getSeasons, getStandings, getTeam, hasSeason, parseYear } from "./archive";

const originalPath = process.env.DATABASE_PATH;
const directory = mkdtempSync("/tmp/opencode/chars-archive-test-");
const path = join(directory, "archive.sqlite");

beforeAll(() => {
  const db = new Database(path);
  try {
    db.exec(`
      CREATE TABLE teams (team_id TEXT PRIMARY KEY, team_name TEXT, abbreviation TEXT);
      CREATE TABLE conferences (conference_id TEXT PRIMARY KEY, name TEXT, abbreviation TEXT);
      CREATE TABLE seasons (team_id TEXT, year INTEGER, conference_id TEXT, classification TEXT);
      CREATE TABLE games (game_id INTEGER PRIMARY KEY, home_team TEXT, away_team TEXT, year INTEGER, week INTEGER, start_date INTEGER, home_score INTEGER, away_score INTEGER, overtimes INTEGER);
      INSERT INTO teams VALUES ('a','Alpha','ALP'), ('b','Beta','BET'), ('c','College C','COL'), ('d','Delta','DEL'), ('e','College E','COE');
      INSERT INTO conferences VALUES ('f','FBS League','F'), ('s','FCS League','S');
      INSERT INTO seasons VALUES ('c',2023,'s','FCS'), ('e',2023,'s','FCS'), ('a',2024,'f','FBS'), ('b',2024,'f','FBS'), ('c',2024,'s','FCS'), ('d',2025,'f','FBS');
      INSERT INTO games VALUES
        (1,'a','b',2024,1,1725148800000,20,20,NULL),
        (2,'c','a',2024,2,1725753600000,7,14,NULL),
        (3,'b','c',2024,3,1726358400000,3,9,NULL),
        (4,'b','a',2024,4,1726963200000,NULL,NULL,NULL),
        (5,'c','b',2024,5,1727568000000,14,NULL,NULL),
        (6,'c','e',2023,1,1693612800000,21,14,NULL);
    `);
  } finally {
    db.close();
  }
  process.env.DATABASE_PATH = path;
});

afterAll(() => {
  if (originalPath === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = originalPath;
  rmSync(directory, { recursive: true, force: true });
});

test("all seasons appear, including FCS-only years with zero FBS games", () => {
  expect(getSeasons()).toEqual([
    { year: 2025, fbsTeams: 1, scheduled: 0, played: 0 },
    { year: 2024, fbsTeams: 2, scheduled: 5, played: 3 },
    { year: 2023, fbsTeams: 0, scheduled: 0, played: 0 },
  ]);
  expect(hasSeason(2023)).toBe(true);
  expect(getStandings(2023)).toEqual([]);
  expect(hasSeason(2022)).toBe(false);
});

test("standings include FBS only and calculate wins, losses, ties, and incomplete games", () => {
  expect(getStandings(2024).map(({ teamId, wins, losses, ties, remaining }) => ({ teamId, wins, losses, ties, remaining }))).toEqual([
    { teamId: "a", wins: 1, losses: 0, ties: 1, remaining: 1 },
    { teamId: "b", wins: 0, losses: 1, ties: 1, remaining: 2 },
  ]);
  expect(getTeam(2024, "c")).toBeNull();
  expect(getStandings(2025)[0].teamId).toBe("d");
  expect(getTeam(2026, "a")).toBeNull();
});

test("schedule shows every game including FCS opponents, with scores from the team's perspective", () => {
  const schedule = getSchedule(2024, "a");
  expect(schedule.map(({ opponentName, home, teamScore, opponentScore }) => ({ opponentName, home, teamScore, opponentScore }))).toEqual([
    { opponentName: "Beta", home: 1, teamScore: 20, opponentScore: 20 },
    { opponentName: "College C", home: 0, teamScore: 14, opponentScore: 7 },
    { opponentName: "Beta", home: 0, teamScore: null, opponentScore: null },
  ]);
  expect(schedule[1].opponentClass).toBe("FCS");
});

test("year URLs must contain exactly four digits", () => {
  expect(parseYear("2024")).toBe(2024);
  expect(parseYear("2024garbage")).toBeNull();
  expect(parseYear("-2024")).toBeNull();
});

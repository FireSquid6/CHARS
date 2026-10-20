import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createCfbdClient, parseGames } from "../src/cfbd";
import { deriveCalendarCandidate, ingest } from "../src/ingest";
import { localKey } from "../src/jobs";
import { backup } from "../src/backup";

const year = 2024;
const team = (id: number, school: string) => ({ id, school, abbreviation: school, conference: "Test", classification: "fbs" });
const game = (homePoints: number | null = 3, awayPoints: number | null = 0) => ({ id: 123, season: year, week: 1, seasonType: "regular", startDate: "2024-09-01T00:00:00Z", homeId: 1, awayId: 2, homeTeam: "A", awayTeam: "B", homePoints, awayPoints, completed: homePoints !== null });
function source<T>(items: T[], raw: unknown = items) { return { url: "https://api.collegefootballdata.com/test", observedAtUtc: "2024-09-02T00:00:00.000Z", items, raw }; }
function input(score = 3) {
  const teamsRaw = [team(1, "A"), team(2, "B")], g = game(score);
  return { fbs: source([1, 2], teamsRaw), teams: source(teamsRaw.map(t => ({ ...t, membership: "FBS" as const, raw: t })), teamsRaw),
    games: parseGames([g], year), gameSources: [source(parseGames([g], year), [g])], rankings: source([], []),
    calendar: source([{ week: 1, seasonType: "regular", startUtc: "2024-08-31T00:00:00.000Z", endUtc: "2024-09-02T00:00:00.000Z" }]) };
}
test("validated client authenticates without exposing key in errors", async () => {
  expect(() => createCfbdClient({ key: "" })).toThrow("CFBD_API_KEY");
  const urls: string[] = [];
  const client = createCfbdClient({ key: "secret", fetcher: async (url, init) => {
    urls.push(String(url)); expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer secret");
    if (String(url).includes("teams/fbs")) return Response.json([team(1, "A"), team(2, "B")]);
    if (String(url).includes("/teams?")) return Response.json([team(1, "A"), team(2, "B")]);
    if (String(url).includes("/games?")) return Response.json([game()]);
    if (String(url).includes("/rankings?")) return Response.json([]);
    return Response.json([{ season: year, week: 1, seasonType: "regular", startDate: "2024-08-31T00:00:00Z", endDate: "2024-09-02T00:00:00Z" }]);
  } });
  expect((await client.season(year)).games).toHaveLength(1);
  expect(urls.every(u => !u.includes("secret"))).toBe(true);
  expect(() => parseGames([game(null, 0)], year)).toThrow("inconsistent scores");
});
test("idempotence, correction audit, and empty response preserve prior SQLite state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chars-ingest-")), db = new Database(":memory:");
  try {
    db.exec("PRAGMA foreign_keys=ON; CREATE TABLE teams(team_id TEXT PRIMARY KEY,team_name TEXT,abbreviation TEXT); CREATE TABLE conferences(conference_id TEXT PRIMARY KEY,name TEXT,abbreviation TEXT); CREATE TABLE seasons(team_id TEXT,year INTEGER,conference_id TEXT,division TEXT,classification TEXT,PRIMARY KEY(team_id,year)); CREATE TABLE games(game_id INTEGER PRIMARY KEY,home_team TEXT,away_team TEXT,year INTEGER,week INTEGER,start_date INTEGER,home_score INTEGER,away_score INTEGER,overtimes INTEGER); CREATE TABLE poll_releases(release_id TEXT PRIMARY KEY,poll_id TEXT,year INTEGER,week INTEGER,released_at INTEGER); CREATE TABLE poll_entries(release_id TEXT,team_id TEXT,rank INTEGER,PRIMARY KEY(release_id,team_id))");
    expect((await ingest(db, year, input(), dir)).counts.inserted).toBe(1);
    expect((await ingest(db, year, input(), dir)).counts.unchanged).toBe(1);
    expect((await ingest(db, year, input(9), dir)).counts.updated).toBe(1);
    expect(db.query<{ home_score: number }, []>("SELECT home_score FROM games").get()?.home_score).toBe(9);
    const previous = await readFile(join(dir, "source", `${year}-audit.json`), "utf8");
    await expect(ingest(db, year, { ...input(), games: [] }, dir)).rejects.toThrow("Incomplete");
    expect(await readFile(join(dir, "source", `${year}-audit.json`), "utf8")).toBe(previous);
    expect(db.query("SELECT game_id FROM games").all()).toHaveLength(1);
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});
test("removed season member still referenced by an old game becomes a coverage gap", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chars-membership-")), db = new Database(":memory:");
  try {
    db.exec("PRAGMA foreign_keys=ON; CREATE TABLE teams(team_id TEXT PRIMARY KEY,team_name TEXT,abbreviation TEXT); CREATE TABLE conferences(conference_id TEXT PRIMARY KEY,name TEXT,abbreviation TEXT); CREATE TABLE seasons(team_id TEXT,year INTEGER,conference_id TEXT,division TEXT,classification TEXT,PRIMARY KEY(team_id,year)); CREATE TABLE games(game_id INTEGER PRIMARY KEY,home_team TEXT,away_team TEXT,year INTEGER,week INTEGER,start_date INTEGER,home_score INTEGER,away_score INTEGER,overtimes INTEGER); CREATE TABLE poll_releases(release_id TEXT PRIMARY KEY,poll_id TEXT,year INTEGER,week INTEGER,released_at INTEGER); CREATE TABLE poll_entries(release_id TEXT,team_id TEXT,rank INTEGER,PRIMARY KEY(release_id,team_id))");
    await ingest(db, year, input(), dir);
    db.exec("INSERT INTO teams VALUES ('3','C','C'); INSERT INTO seasons VALUES ('3',2024,'Test',NULL,'FBS'); INSERT INTO games VALUES (999,'1','3',2024,1,1725148800000,10,0,NULL)");
    const audit = await ingest(db, year, input(), dir);
    expect(audit.coverage.some(gap => gap.includes("team 3 absent") && gap.includes("game 999"))).toBe(true);
    expect(db.query("SELECT team_id FROM seasons WHERE team_id='3'").all()).toHaveLength(1);
    expect(db.query("SELECT game_id FROM games WHERE game_id=999").all()).toHaveLength(1);
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});
test("Chicago midnight keys change on local dates across both DST transitions", () => {
  expect(localKey(new Date("2026-03-08T05:59:59Z"))).toBe("2026-03-07");
  expect(localKey(new Date("2026-03-08T06:00:00Z"))).toBe("2026-03-08");
  expect(localKey(new Date("2026-11-01T04:59:59Z"))).toBe("2026-10-31");
  expect(localKey(new Date("2026-11-01T05:00:00Z"))).toBe("2026-11-01");
});
test("calendar proposal needs a classified CCG and a distinct completed calendar window", () => {
  const regular = parseGames([game()], year)[0]!;
  const ccg = parseGames([{ ...game(null, null), id: 124, week: 3, seasonType: "postseason", startDate: "2024-09-20T00:00:00Z", notes: "Conference Championship" }], year)[0]!;
  const games = [{ game: regular, type: "regular" as const }, { game: ccg, type: "ccg" as const }];
  const weeks = [{ week: 1, seasonType: "regular", startUtc: "2024-08-31T00:00:00.000Z", endUtc: "2024-09-02T00:00:00.000Z" }];
  expect(deriveCalendarCandidate(games, weeks)).toEqual({ freezeUtc: weeks[0]!.endUtc, firstCcgUtc: ccg.startDate, verified: false, provenance: "cfbd-calendar-and-explicit-ccg" });
  expect(deriveCalendarCandidate(games.slice(0, 1), weeks)).toBeNull();
  expect(deriveCalendarCandidate([...games, { game: ccg, type: "unknown" }], weeks)).toBeNull();
  expect(deriveCalendarCandidate(games, [...weeks, { week: 2, seasonType: "regular", startUtc: "2024-09-19T00:00:00.000Z", endUtc: "2024-09-21T00:00:00.000Z" }])).toBeNull();
});
test("backup captures committed WAL rows and refuses to overwrite", async () => {
  const dir = await mkdtemp(join(tmpdir(), "chars-backup-"));
  const path = join(dir, "source.sqlite"), target = join(dir, "backup.sqlite");
  const db = new Database(path);
  try {
    db.exec("PRAGMA journal_mode=WAL; CREATE TABLE x(id INTEGER PRIMARY KEY); INSERT INTO x VALUES (1)");
    await backup(path, target);
    const copy = new Database(target, { readonly: true });
    try { expect(copy.query("SELECT * FROM x").all()).toEqual([{ id: 1 }]); }
    finally { copy.close(); }
    await expect(backup(path, target)).rejects.toThrow("already exists");
  } finally { db.close(); await rm(dir, { recursive: true, force: true }); }
});

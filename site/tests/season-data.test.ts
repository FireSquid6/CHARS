import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openDatabase } from "../../packages/chars-db/src/index";
import { migrate } from "../../packages/chars-db/src/migrate";
import { currentFootballSeason, getHomeData, getSeasonData, supportedYears } from "../lib/season-data";

const previous = { path: process.env.DATABASE_PATH, key: process.env.CFBD_API_KEY };
const dirs: string[] = [];
afterEach(() => {
  if (previous.path === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous.path;
  if (previous.key === undefined) delete process.env.CFBD_API_KEY; else process.env.CFBD_API_KEY = previous.key;
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

test("football year rolls over in July and home links include 1998 through preseason", () => {
  delete process.env.DATABASE_PATH;
  delete process.env.CFBD_API_KEY;
  expect(currentFootballSeason(new Date("2027-01-01T12:00:00Z"))).toBe(2026);
  expect(currentFootballSeason(new Date("2027-07-01T12:00:00Z"))).toBe(2027);
  const years = supportedYears(new Date("2027-01-01T12:00:00Z"));
  expect(years[0]).toBe(2026);
  expect(years.at(-1)).toBe(1998);
  const home = getHomeData(new Date("2027-01-01T12:00:00Z"));
  expect(home.seasons[0]).toMatchObject({ year: 2026, state: "preseason" });
  expect(home.seasons.at(-1)).toMatchObject({ year: 1998, state: "incomplete" });
  expect(home.setup).toContain("DATABASE_PATH");
});

test("readers use published revision, allow exact historical key and disclose stale final", async () => {
  const dir = mkdtempSync("/tmp/opencode/chars-site-"); dirs.push(dir);
  process.env.DATABASE_PATH = join(dir, "data.db");
  delete process.env.CFBD_API_KEY;
  const db = openDatabase({ path: process.env.DATABASE_PATH });
  try {
    await migrate(db);
    db.query("INSERT INTO seasons (year,state,calendar_policy_version) VALUES (2020,'final','test')").run();
    db.query("INSERT INTO teams (id,name) VALUES ('A','Alpha'),('B','Beta')").run();
    db.query("INSERT INTO team_seasons (season,team_id,membership) VALUES (2020,'A','fbs'),(2020,'B','fbs')").run();
    const insert = db.query(`INSERT INTO snapshots (snapshot_key,revision,season,week,kind,game_cutoff_utc,input_hash,
      policy_version,model_version,calendar_policy_version,coverage_json,published_at_utc)
      VALUES (?,?,2020,?,?,'2020-11-29T00:00:00.000Z',?,'test','test','test',?,'2020-12-01T00:00:00.000Z')`);
    const complete = JSON.stringify({ complete: true, reasons: [] });
    insert.run("2020:week:1", 1, 1, "week_final", "weekly", complete);
    insert.run("2020:selection-final", 1, 14, "selection_final", "old", complete);
    insert.run("2020:selection-final", 2, 14, "selection_final", "unpublished", complete);
    db.query("INSERT INTO snapshot_publications (snapshot_key,revision,published_at_utc,state) VALUES ('2020:week:1',1,'2020-12-01T00:00:00.000Z','current'),('2020:selection-final',1,'2020-12-01T00:00:00.000Z','current')").run();
    const ranking = db.query(`INSERT INTO snapshot_rankings (snapshot_key,snapshot_revision,team_id,wins,losses,ties,rating,residual,precision_method,
      colley_rank,adjusted_rank,eligible,original_route,final_category) VALUES (?,?,?,9,3,0,?,0,'double',1,1,1,'colley_minimum_bid','bid')`);
    ranking.run("2020:selection-final", 1, "A", .85);
    ranking.run("2020:selection-final", 2, "A", .99);
    ranking.run("2020:week:1", 1, "B", .5);
    expect(getSeasonData(2020).snapshot?.revision).toBe(1);
    expect(getSeasonData(2020).rankings[0]?.rating).toBe(.85);
    expect(getSeasonData(2020, "2020:week:1").rankings[0]?.name).toBe("Beta");
    expect(getSeasonData(2020, "2020:selection-final:fake").snapshot).toBeNull();
    db.query("UPDATE snapshot_publications SET state='pending' WHERE snapshot_key='2020:week:1'").run();
    expect(getSeasonData(2020).pending).toBe(true);
    expect(getSeasonData(2020, "2020:week:1").snapshot).toBeNull();
    db.query("UPDATE snapshot_publications SET state='current' WHERE snapshot_key='2020:week:1'").run();
    db.query("UPDATE snapshot_publications SET state='stale' WHERE snapshot_key='2020:selection-final'").run();
    expect(getSeasonData(2020).state).toBe("incomplete");
    expect(getSeasonData(2020, "2020:selection-final").snapshot?.publicationState).toBe("stale");
  } finally { db.close(); }
});

import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { openDatabase, createRepository } from "../src/index";
import { migrate } from "../src/migrate";
import { planSnapshots, publishedSnapshot, rebuildSnapshots } from "../src/snapshots";

const dirs: string[] = [];
afterEach(() => { for (const path of dirs.splice(0)) rmSync(path, { recursive: true, force: true }); });
async function fixture() {
  const path = mkdtempSync("/tmp/opencode/chars-snapshots-"); dirs.push(path);
  const db = openDatabase({ path: join(path, "data.db") }); await migrate(db);
  const repo = createRepository(db);
  const year = 2020;
  const coverage = JSON.stringify({ fbsRoster: true, schedule: true, calendar: true, gameClassification: true,
    gameMembership: true, gameStatusKnown: true, selectionFreeze: true });
  repo.saveSeason({ year, state: "incomplete", selectionFreezeUtc: "2020-11-29T00:00:00.000Z",
    calendarPolicyVersion: "pre-ccg-weekend-v1", coverage });
  db.query("INSERT INTO season_input_generations (season, generation) VALUES (2020, 1)").run();
  for (const id of ["A", "B", "FCS"]) {
    repo.saveTeam({ id, providerId: id, name: id, abbreviation: id });
    repo.saveTeamSeason({ season: year, teamId: id, membership: id === "FCS" ? "fcs" : "fbs", conference: null });
  }
  for (const [week, start, end] of [
    [0, "2020-08-22T00:00:00.000Z", "2020-08-30T00:00:00.000Z"],
    [1, "2020-08-31T00:00:00.000Z", "2020-09-07T00:00:00.000Z"],
    [2, "2020-09-08T00:00:00.000Z", "2020-09-15T00:00:00.000Z"],
    [14, "2020-11-22T00:00:00.000Z", "2020-11-29T00:00:00.000Z"],
    [15, "2020-11-30T00:00:00.000Z", "2020-12-06T00:00:00.000Z"]
  ] as const) db.query("INSERT INTO season_calendar_weeks (season, season_type, week, start_utc, end_utc, source_hash) VALUES (2020, 'regular', ?, ?, ?, ?)")
    .run(week, start, end, `calendar-${week}`);
  for (let i = 3; i <= 13; i++) {
    const start = new Date(Date.parse("2020-09-16T00:00:00.000Z") + (i - 3) * 6 * 86400000).toISOString();
    const end = new Date(Date.parse(start) + 5 * 86400000).toISOString();
    db.query("INSERT INTO season_calendar_weeks (season, season_type, week, start_utc, end_utc, source_hash) VALUES (2020, 'regular', ?, ?, ?, ?)")
      .run(i, start, end, `calendar-${i}`);
  }
  function game(id: string, week: number, home: string, away: string, type: string, kickoff: string, score: number | null) {
    db.query(`INSERT INTO games (id,provider_game_id,season,week,home_team_id,away_team_id,kickoff_utc,
      home_score,away_score,status,completed,provider_season_type,application_game_type,classification_source,
      first_seen_utc,last_seen_utc,payload_hash,completed_at_utc) VALUES (?,?,2020,?,?,?,?,?,?,?,?,'regular',?,'test',?,?,?,?)`)
      .run(id, id, week, home, away, kickoff, score, score === null ? null : 0,
        score === null ? "scheduled" : "completed", Number(score !== null), type, kickoff, kickoff, `hash-${id}`,
        score === null ? null : kickoff);
    db.query("INSERT INTO game_revisions (game_id,revision,payload_hash,observed_at_utc,normalized_json) VALUES (?,1,?,?,'{}')")
      .run(id, `hash-${id}`, kickoff);
  }
  game("week0", 0, "A", "FCS", "regular", "2020-08-25T00:00:00.000Z", 21);
  game("week1", 1, "A", "B", "regular", "2020-09-05T00:00:00.000Z", 7);
  game("late", 14, "B", "FCS", "regular", "2020-11-25T00:00:00.000Z", 14);
  game("ccg", 15, "A", "B", "ccg", "2020-12-04T00:00:00.000Z", 99);
  game("bowl", 15, "A", "FCS", "bowl", "2020-12-05T00:00:00.000Z", 77);
  function poll(id: string, type: string, week: number, effective: string) {
    db.query(`INSERT INTO poll_releases (id,season,poll_type,game_week,effective_at_utc,source_hash,
      timing_provenance,provider_season_type) VALUES (?,2020,?,?,?,?,'derived_convention','regular')`)
      .run(id, type, week, effective, id);
    db.query("INSERT INTO poll_entries (release_id,team_id,rank) VALUES (?,'A',1)").run(id);
  }
  poll("ap-week2", "ap", 2, "2020-09-08T00:00:00.000Z");
  poll("cfp-final", "cfp", 15, "2020-11-30T00:00:00.000Z");
  poll("cfp-too-late", "cfp", 16, "2020-12-08T00:00:00.000Z");
  return { db, repo, game, poll };
}

test("week zero, preseason, AP fallback, and pre-CCG final isolate future results", async () => {
  const { db, repo } = await fixture();
  try {
    const plans = planSnapshots(db, 2020, "2020-12-10T00:00:00.000Z");
    expect(plans.map(p => p.key)).toContain("2020:week:0");
    const report = rebuildSnapshots(db, 2020, "2020-12-10T00:00:00.000Z");
    expect(report.incomplete.some(item => item.key === "2020:selection-final")).toBe(false);
    expect(report.published).toContain("2020:selection-final");
    const final = repo.publishedSnapshots(2020).find(s => s.kind === "selection_final")!;
    expect(final.pollReleaseId).toBe("cfp-final");
    expect(db.query<{ game_id: string }, []>("SELECT game_id FROM snapshot_games WHERE snapshot_key='2020:selection-final' ORDER BY game_id").all()
      .map(r => r.game_id)).toEqual(["late", "week0", "week1"]);
    expect(db.query<{ poll_release_id: string }, []>("SELECT poll_release_id FROM snapshots WHERE snapshot_key='2020:week:1'").get()?.poll_release_id).toBe("ap-week2");
    expect(db.query<{ wins: number }, []>("SELECT wins FROM snapshot_rankings WHERE snapshot_key='2020:preseason' AND team_id='A'").get()?.wins).toBe(0);
    expect(rebuildSnapshots(db, 2020, "2020-12-10T00:00:00.000Z").published).toEqual([]);
    db.query("UPDATE games SET home_score=0,away_score=200,result_revision=2 WHERE id='ccg'").run();
    db.query("INSERT INTO game_revisions (game_id,revision,payload_hash,observed_at_utc,normalized_json) VALUES ('ccg',2,'corrected','2020-12-11','{}')").run();
    expect(rebuildSnapshots(db, 2020, "2020-12-10T00:00:00.000Z").published).toEqual([]);
    db.query("UPDATE games SET home_score=0,away_score=7,result_revision=2,payload_hash='corrected' WHERE id='week1'").run();
    db.query("INSERT INTO game_revisions (game_id,revision,payload_hash,observed_at_utc,normalized_json) VALUES ('week1',2,'corrected','2020-12-11','{}')").run();
    const changed = rebuildSnapshots(db, 2020, "2020-12-10T00:00:00.000Z");
    expect(changed.published).toContain("2020:selection-final");
    expect(changed.published).not.toContain("2020:week:0");
    expect(publishedSnapshot(db, "2020:selection-final")?.revision).toBe(2);
  } finally { db.close(); }
});

test("unverified final stays unavailable, previous final remains visible on failed rebuild", async () => {
  const { db, repo } = await fixture();
  try {
    db.query("UPDATE poll_releases SET is_current=0 WHERE id='cfp-final'").run();
    expect(rebuildSnapshots(db, 2020, "2020-12-10T00:00:00.000Z").incomplete.find(x => x.key === "2020:selection-final")?.reasons)
      .toContain("missing corresponding pre-CCG poll release");
    expect(publishedSnapshot(db, "2020:selection-final")).toBeNull();
    db.query("UPDATE poll_releases SET is_current=1 WHERE id='cfp-final'").run();
    rebuildSnapshots(db, 2020, "2020-12-10T00:00:00.000Z");
    db.query("UPDATE games SET status='scheduled',completed=0,home_score=NULL,away_score=NULL WHERE id='late'").run();
    const failed = rebuildSnapshots(db, 2020, "2020-12-10T00:00:00.000Z");
    expect(failed.incomplete.find(x => x.key === "2020:selection-final")?.reasons).toContain("unresolved scheduled game late");
    expect(repo.publishedSnapshots(2020).find(s => s.kind === "selection_final")?.revision).toBe(1);
  } finally { db.close(); }
});

test("a failed dependent insert rolls back revision and publication pointer", async () => {
  const { db, repo } = await fixture();
  try {
    rebuildSnapshots(db, 2020, "2020-12-10T00:00:00.000Z");
    db.query("UPDATE games SET home_score=0,away_score=7,result_revision=2,payload_hash='new' WHERE id='week1'").run();
    db.query("INSERT INTO game_revisions (game_id,revision,payload_hash,observed_at_utc,normalized_json) VALUES ('week1',2,'new','2020-12-11','{}')").run();
    db.exec(`CREATE TRIGGER reject_ranking BEFORE INSERT ON snapshot_rankings
      WHEN NEW.snapshot_key='2020:selection-final' AND NEW.snapshot_revision=2
      BEGIN SELECT RAISE(ABORT, 'test publication failure'); END`);
    expect(() => rebuildSnapshots(db, 2020, "2020-12-10T00:00:00.000Z")).toThrow("test publication failure");
    expect(repo.publishedSnapshots(2020).find(s => s.kind === "selection_final")?.revision).toBe(1);
    expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM snapshots WHERE snapshot_key='2020:selection-final' AND revision=2").get()?.count).toBe(0);
    db.exec("DROP TRIGGER reject_ranking");
    expect(rebuildSnapshots(db, 2020, "2020-12-10T00:00:00.000Z").published).toContain("2020:selection-final");
  } finally { db.close(); }
});

test("2014+ final accepts only corresponding pre-CCG CFP convention without a next calendar week", async () => {
  const { db } = await fixture();
  try {
    db.query("DELETE FROM season_calendar_weeks WHERE season=2020 AND week=15").run();
    db.query(`UPDATE poll_releases SET effective_at_utc='2020-12-04T00:00:00.000Z',
      timing_provenance='derived_pre_ccg_cutoff' WHERE id='cfp-final'`).run();
    const result = rebuildSnapshots(db, 2020, "2020-12-10T00:00:00.000Z");
    expect(result.published).toContain("2020:selection-final");
    expect(result.incomplete.find(x => x.key === "2020:selection-final")).toBeUndefined();
    expect(db.query<{ poll_release_id: string; poll_cutoff_utc: string }, []>(
      "SELECT poll_release_id,poll_cutoff_utc FROM snapshots WHERE snapshot_key='2020:selection-final'").get())
      .toEqual({ poll_release_id: "cfp-final", poll_cutoff_utc: "2020-12-04T00:00:00.000Z" });
    db.query("UPDATE poll_releases SET released_at_utc='2020-12-04T00:00:00.000Z' WHERE id='cfp-final'").run();
    expect(rebuildSnapshots(db, 2020, "2020-12-10T00:00:00.000Z").incomplete.find(x => x.key === "2020:selection-final")?.reasons)
      .toContain("missing corresponding pre-CCG poll release");
    expect(publishedSnapshot(db, "2020:selection-final")?.revision).toBe(1);
  } finally { db.close(); }
});

test("known release must follow frozen games and precede first CCG", async () => {
  const { db } = await fixture();
  try {
    db.query("UPDATE poll_releases SET released_at_utc='2020-11-29T00:00:00.000Z' WHERE id='cfp-final'").run();
    expect(rebuildSnapshots(db, 2020, "2020-12-10T00:00:00.000Z").incomplete.find(x => x.key === "2020:selection-final")?.reasons)
      .toContain("missing corresponding pre-CCG poll release");
    db.query("UPDATE poll_releases SET released_at_utc='2020-12-01T00:00:00.000Z' WHERE id='cfp-final'").run();
    expect(rebuildSnapshots(db, 2020, "2020-12-10T00:00:00.000Z").published).toContain("2020:selection-final");
    db.query("UPDATE poll_releases SET released_at_utc='2020-12-04T00:00:00.000Z' WHERE id='cfp-final'").run();
    expect(rebuildSnapshots(db, 2020, "2020-12-10T00:00:00.000Z").incomplete.find(x => x.key === "2020:selection-final")?.reasons)
      .toContain("missing corresponding pre-CCG poll release");
    expect(publishedSnapshot(db, "2020:selection-final")?.revision).toBe(1);
  } finally { db.close(); }
});

test("two-connection correction between read and publication cannot expose a stale revision", async () => {
  const { db, repo } = await fixture();
  const other = openDatabase({ path: db.filename });
  try {
    rebuildSnapshots(db, 2020, "2020-12-10T00:00:00.000Z");
    const report = rebuildSnapshots(db, 2020, "2020-12-10T00:00:00.000Z", { beforePublish: plan => {
      if (plan.kind !== "selection_final") return;
      other.transaction(() => {
        other.query("UPDATE games SET home_score=0, away_score=7, result_revision=2, payload_hash='new' WHERE id='week1'").run();
        other.query("INSERT INTO game_revisions (game_id,revision,payload_hash,observed_at_utc,normalized_json) VALUES ('week1',2,'new','2020-12-11','{}')").run();
        other.query("UPDATE season_input_generations SET generation=generation+1 WHERE season=2020").run();
        other.query("UPDATE snapshot_publications SET state='stale' WHERE snapshot_key='2020:selection-final'").run();
      })();
    } });
    expect(report.incomplete.find(x => x.key === "2020:selection-final")?.reasons)
      .toContain("source changed during rebuild; retry");
    expect(repo.publishedSnapshots(2020).find(s => s.kind === "selection_final"))
      .toMatchObject({ revision: 1, publicationState: "stale" });
    expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM snapshots WHERE snapshot_key='2020:selection-final'").get()?.count).toBe(1);
    expect(rebuildSnapshots(db, 2020, "2020-12-10T00:00:00.000Z").published).toContain("2020:selection-final");
    expect(repo.publishedSnapshots(2020).find(s => s.kind === "selection_final"))
      .toMatchObject({ revision: 2, publicationState: "current" });
  } finally { other.close(); db.close(); }
});

test("obsolete weekly keys disappear while an invalidated final remains visibly stale", async () => {
  const { db, repo } = await fixture();
  try {
    rebuildSnapshots(db, 2020, "2020-12-10T00:00:00.000Z");
    db.query("DELETE FROM season_calendar_weeks WHERE season=2020 AND week=1").run();
    db.query("UPDATE season_input_generations SET generation=generation+1 WHERE season=2020").run();
    rebuildSnapshots(db, 2020, "2020-12-10T00:00:00.000Z");
    expect(repo.publishedSnapshots(2020).some(s => s.key === "2020:week:1")).toBe(false);
    expect(repo.publishedSnapshots(2020).find(s => s.kind === "selection_final")?.publicationState).toBe("stale");
  } finally { db.close(); }
});

test("unknown weekly classification is incomplete; observed partial completion is usable without historical timestamp", async () => {
  const { db } = await fixture();
  try {
    db.query("UPDATE games SET completed_at_utc=NULL WHERE id='week1'").run();
    rebuildSnapshots(db, 2020, "2020-09-06T00:00:00.000Z");
    expect(db.query<{ wins: number }, []>("SELECT wins FROM snapshot_rankings WHERE snapshot_key='2020:week:1:partial' AND team_id='A'").get()?.wins).toBe(2);
    db.query("UPDATE game_revisions SET observed_at_utc='2020-09-08T00:00:00.000Z' WHERE game_id='week1' AND revision=1").run();
    const partial = rebuildSnapshots(db, 2020, "2020-09-06T00:00:00.000Z");
    expect(partial.incomplete.find(x => x.key === "2020:week:1:partial")?.reasons)
      .toContain("unverified partial completion week1");
    db.query("UPDATE games SET application_game_type='unknown' WHERE id='week1'").run();
    const weekly = rebuildSnapshots(db, 2020, "2020-09-10T00:00:00.000Z");
    expect(weekly.incomplete.find(x => x.key === "2020:week:1")?.reasons)
      .toContain("unknown game classification week1");
  } finally { db.close(); }
});

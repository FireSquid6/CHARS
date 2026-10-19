import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "chars-cfbd";
import { openDatabase } from "../src/index";
import { parseBackfillArgs } from "../src/backfill";
import { currentFootballSeason, derivePollTiming, fetchSeason, ingestSeason, pollTimingConvention } from "../src/ingest";
import { migrate } from "../src/migrate";
import { rebuildSnapshots, publishedSnapshot } from "../src/snapshots";
import { gamesAtCutoff, pollsAtCutoff } from "../src/temporal";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
const year = 1998;
const team = (id: number, classification: string) => ({ id, school: `School ${id}`, classification,
  abbreviation: `S${id}`, alternateNames: [`University ${id}`], conference: "Test" });
const base = { id: 11, season: year, week: 1, seasonType: "regular", startDate: "1998-09-05T20:00:00Z",
  completed: false, homeId: 1, awayId: 2, homeTeam: "School 1", awayTeam: "School 2",
  homePoints: 0, awayPoints: 0, homeClassification: "fbs", awayClassification: "fcs", notes: null, playoff: null, status: "scheduled" };
function client(games: unknown[], ranks: unknown[] = [], calendar: unknown[] = [
  { season: year, seasonType: "regular", week: 1, startDate: "1998-09-01T00:00:00Z", endDate: "1998-09-08T00:00:00Z" }
]) {
  return createClient({ apiKey: "offline", now: () => new Date("2026-10-19T10:00:00Z"), fetch: async (url) => {
    const target = new URL(url.toString());
    const data = target.pathname === "/teams/fbs" ? [team(1, "fbs")] :
      target.pathname === "/teams" ? [team(1, "fbs"), team(2, "fcs")] :
      target.pathname === "/calendar" ? calendar : target.pathname === "/rankings" ? ranks :
      target.searchParams.get("classification") === "fbs" ? games : [];
    return Response.json(data);
  } });
}
async function setup() {
  const dir = mkdtempSync("/tmp/opencode/chars-ingest-"); dirs.push(dir);
  const db = openDatabase({ path: join(dir, "data.sqlite") });
  await migrate(db);
  return db;
}

test("first insert, repeated observation, FCS win, correction and raw provenance", async () => {
  const db = await setup();
  try {
    const first = ingestSeason(db, year, await fetchSeason(client([base]), year));
    expect(first).toMatchObject({ inserted: 1, revised: 0, coverage: { selectionFreeze: false, polls: false } });
    expect(db.query<{ application_game_type: string }, []>("SELECT application_game_type FROM games").get()?.application_game_type).toBe("regular");
    expect(ingestSeason(db, year, await fetchSeason(client([base]), year))).toMatchObject({ unchanged: 1, revised: 0 });
    expect(db.query("SELECT * FROM game_revisions").all()).toHaveLength(1);
    expect(db.query("SELECT * FROM ingestion_payloads WHERE source='cfbd:games'").all()).toHaveLength(4);
    const result = { ...base, completed: true, status: "completed", homePoints: 14, awayPoints: 7 };
    expect(ingestSeason(db, year, await fetchSeason(client([result]), year))).toMatchObject({ revised: 1 });
    const rows = db.query<{ revision: number; payload_id: string; previous_normalized_json: string | null; normalized_json: string }, []>(
      "SELECT revision, payload_id, previous_normalized_json, normalized_json FROM game_revisions ORDER BY revision").all();
    expect(rows).toHaveLength(2);
    expect(rows[1]?.previous_normalized_json).toBe(rows[0]?.normalized_json);
    expect(db.query<{ home_score: number; completed: number }, []>("SELECT home_score, completed FROM games").get()).toMatchObject({ home_score: 14, completed: 1 });
    expect(db.query<{ raw_json: string }, [string]>("SELECT raw_json FROM ingestion_payloads WHERE id=?").get(rows[1]!.payload_id)?.raw_json).toContain('"homePoints":14');
    expect(db.query<{ membership: string }, []>("SELECT membership FROM team_seasons WHERE team_id='cfbd:2'").get()?.membership).toBe("fcs");
    expect(gamesAtCutoff(db, year, "1998-09-05T23:00:00Z")).toEqual([]);
    expect(gamesAtCutoff(db, year, "1998-09-08T00:00:00Z").map(g => g.id)).toEqual(["cfbd:11"]);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { db.close(); }
});

test("cancelled 0-0, unknown classifications, poll ties/unranked, missing calendar; rollback invalid poll identity", async () => {
  const db = await setup();
  try {
    const polls = [{ season: year, seasonType: "regular", week: 1, polls: [{ poll: "AP Top 25", isFinal: false,
      ranks: [{ teamId: 1, school: "School 1", rank: 1, points: 10 }, { teamId: 2, school: "School 2", rank: 1, points: 10 }] }] }];
    const cancelled = { ...base, status: "cancelled", notes: "Game canceled" };
    const result = ingestSeason(db, year, await fetchSeason(client([cancelled], polls, []), year));
    expect(result.coverage).toMatchObject({ calendar: false, gameClassification: false, pollReleaseTiming: false });
    expect(db.query<{ status: string; home_score: number | null }, []>("SELECT status, home_score FROM games").get())
      .toMatchObject({ status: "cancelled", home_score: null });
    expect(db.query<{ timing_provenance: string; released_at_utc: string | null }, []>("SELECT timing_provenance, released_at_utc FROM poll_releases").get())
      .toMatchObject({ timing_provenance: "unknown", released_at_utc: null });
    expect(db.query<{ rank: number }, []>("SELECT rank FROM poll_entries").all().map(r => r.rank)).toEqual([1, 1]);
    expect(pollsAtCutoff(db, year, "1998-12-31T00:00:00Z")).toEqual([]);
    const unranked = [{ ...polls[0], polls: [{ ...polls[0]!.polls[0], ranks: [{ teamId: 1, school: "School 1", rank: null, points: 0 }] }] }];
    ingestSeason(db, year, await fetchSeason(client([cancelled], unranked, []), year));
    expect(db.query("SELECT * FROM poll_entries WHERE rank IS NULL").all()).toHaveLength(1);
    const broken = [{ ...polls[0], polls: [{ ...polls[0]!.polls[0], ranks: [{ teamId: 999, school: "Absent", rank: 1, points: 1 }] }] }];
    const brokenInput = await fetchSeason(client([cancelled], broken, []), year);
    const before = db.query<{ count: number }, []>("SELECT count(*) AS count FROM ingestion_payloads").get()!.count;
    expect(() => ingestSeason(db, year, brokenInput)).toThrow("Unknown CFBD team ID");
    expect(db.query<{ count: number }, []>("SELECT count(*) AS count FROM ingestion_payloads").get()?.count).toBe(before);
  } finally { db.close(); }
});

test("range parsing and Chicago season boundary", () => {
  expect(currentFootballSeason(new Date("2026-01-01T04:30:00Z"))).toBe(2025);
  expect(currentFootballSeason(new Date("2026-01-01T06:30:00Z"))).toBe(2025);
  expect(currentFootballSeason(new Date("2026-07-01T05:01:00Z"))).toBe(2026);
  expect(parseBackfillArgs(["--from", "1998", "--to", "CURRENT"], new Date("2026-01-15T00:00:00Z")).at(-1)).toBe(2025);
  expect(parseBackfillArgs(["--season", "1998"])).toEqual([1998]);
  expect(() => parseBackfillArgs(["--from", "2000", "--to", "1998"])).toThrow();
});

test("CCG freeze uses preceding full calendar week; uncertain postseason and future results stay out", async () => {
  const db = await setup();
  try {
    const ccg = { ...base, id: 12, seasonType: "postseason", week: 2, startDate: "1998-09-12T20:00:00Z",
      completed: true, status: "completed", homePoints: 35, awayPoints: 21, notes: "Conference Championship" };
    const unknown = { ...base, id: 13, seasonType: "postseason", week: 3, startDate: "1998-09-20T20:00:00Z",
      completed: true, status: "completed", homePoints: 24, awayPoints: 0 };
    const calendar = [
      { season: year, seasonType: "regular", week: 1, startDate: "1998-09-01T00:00:00Z", endDate: "1998-09-08T00:00:00Z" },
      { season: year, seasonType: "postseason", week: 2, startDate: "1998-09-09T00:00:00Z", endDate: "1998-09-16T00:00:00Z" }
    ];
    const input = await fetchSeason(client([{ ...base, status: "completed", completed: true, homePoints: 7, awayPoints: 0 }, ccg, unknown], [], calendar), year);
    expect(ingestSeason(db, year, input)).toMatchObject({ selectionFreezeUtc: "1998-09-08T00:00:00.000Z",
      coverage: { gameClassification: false } });
    expect(db.query<{ application_game_type: string }, []>("SELECT application_game_type FROM games ORDER BY id").all()
      .map(row => row.application_game_type)).toEqual(["regular", "ccg", "unknown"]);
    expect(gamesAtCutoff(db, year, "1999-01-01T00:00:00Z").map(g => g.id)).toEqual(["cfbd:11"]);
    expect(db.query<{ classification_provenance_json: string }, []>("SELECT classification_provenance_json FROM games WHERE id='cfbd:12'").get()?.classification_provenance_json)
      .toContain("explicit_conference_championship_notes");
  } finally { db.close(); }
});

test("season conference name classifies a named championship; unrelated titles stay unknown", async () => {
  const db = await setup();
  try {
    const named = { ...base, id: 33, status: "completed", completed: true, homePoints: 14, awayPoints: 7,
      seasonType: "postseason", notes: "SEC Championship", startDate: "1998-09-15T20:00:00Z" };
    const uncertain = { ...named, id: 34, notes: "Invitational Championship" };
    const input = await fetchSeason(client([named, uncertain]), year);
    input.teams.items[0]!.conference = "SEC";
    expect(ingestSeason(db, year, input).coverage.gameClassification).toBe(false);
    expect(db.query<{ application_game_type: string }, []>("SELECT application_game_type FROM games ORDER BY id").all()
      .map(row => row.application_game_type)).toEqual(["ccg", "unknown"]);
    expect(db.query<{ classification_provenance_json: string }, []>("SELECT classification_provenance_json FROM games WHERE id='cfbd:33'").get()?.classification_provenance_json)
      .toContain("season_conference_named_championship");
  } finally { db.close(); }
});

test("unknown and contradictory game status aborts before any write, retaining final metadata and results", async () => {
  const db = await setup();
  try {
    ingestSeason(db, year, await fetchSeason(client([{ ...base, completed: true, status: "completed", homePoints: 17, awayPoints: 3 }]), year));
    db.query("UPDATE seasons SET state='final', coverage_json='{" + '"validated":true' + "}', selection_freeze_utc='1998-12-01T00:00:00Z' WHERE year=?").run(year);
    const before = db.query<{ home_score: number }, []>("SELECT home_score FROM games").get();
    const observations = db.query<{ count: number }, []>("SELECT count(*) AS count FROM ingestion_payloads").get()?.count;
    const contradictory = await fetchSeason(client([{ ...base, completed: true, status: "cancelled", homePoints: 0, awayPoints: 0 }]), year);
    expect(() => ingestSeason(db, year, contradictory)).toThrow("unknown or contradictory provider status");
    expect(db.query<{ home_score: number }, []>("SELECT home_score FROM games").get()).toEqual(before);
    expect(db.query<{ count: number }, []>("SELECT count(*) AS count FROM ingestion_payloads").get()?.count).toBe(observations);
    expect(() => ingestSeason(db, year, awaitInputWithoutStatus(contradictory))).toThrow("unknown or contradictory provider status");
    expect(ingestSeason(db, year, await fetchSeason(client([]), year))).toMatchObject({ coverage: { schedule: false } });
    expect(db.query<{ state: string; coverage_json: string; selection_freeze_utc: string }, []>("SELECT state, coverage_json, selection_freeze_utc FROM seasons").get())
      .toMatchObject({ state: "final", coverage_json: '{"validated":true}', selection_freeze_utc: "1998-12-01T00:00:00Z" });
    expect(db.query("SELECT * FROM season_ingestion_gaps").all()).toHaveLength(2);
  } finally { db.close(); }
});

function awaitInputWithoutStatus(input: Awaited<ReturnType<typeof fetchSeason>>) {
  const game = input.games.items[0]!;
  return { ...input, games: { ...input.games, items: [{ ...game, status: "unknown" as const }] } };
}

test("poll week convention, corrected release supersession, calendar revision invalidation and late finish", async () => {
  const db = await setup();
  try {
    const calendar = [
      { season: year, seasonType: "regular", week: 1, startDate: "1998-09-01T00:00:00Z", endDate: "1998-09-08T00:00:00Z" },
      { season: year, seasonType: "regular", week: 2, startDate: "1998-09-09T00:00:00Z", endDate: "1998-09-16T00:00:00Z" }
    ];
    const poll = (points: number) => [{ season: year, seasonType: "regular", week: 2,
      polls: [{ poll: "AP Top 25", isFinal: false, ranks: [
        { teamId: 1, school: "School 1", rank: 1, points }, { teamId: 2, school: "School 2", rank: 1, points: 20 }] }] }];
    const completed = { ...base, status: "completed", completed: true, homePoints: 10, awayPoints: 0 };
    ingestSeason(db, year, await fetchSeason(client([completed], poll(30), calendar), year));
    expect(pollsAtCutoff(db, year, "1998-09-08T23:59:59Z")).toEqual([]);
    expect(pollsAtCutoff(db, year, "1998-09-09T00:00:00Z")).toMatchObject([{ game_week: 2, timing_provenance: "derived_convention" }]);
    db.query(`INSERT INTO snapshots (snapshot_key, revision, season, kind, game_cutoff_utc, input_hash, policy_version,
      model_version, calendar_policy_version, coverage_json, published_at_utc)
      VALUES ('weekly', 1, 1998, 'week_final', '1998-09-16T00:00:00Z', 'hash', 'v1', 'v1', 'v1', '{}', '1998-09-17T00:00:00Z')`).run();
    ingestSeason(db, year, await fetchSeason(client([completed], poll(40), calendar), year));
    expect(db.query<{ is_current: number }, []>("SELECT is_current FROM poll_releases ORDER BY id").all().map(r => r.is_current).sort()).toEqual([0, 1]);
    expect(pollsAtCutoff(db, year, "1998-09-10T00:00:00Z")).toHaveLength(1);
    expect(db.query("SELECT * FROM snapshot_input_invalidations WHERE reason='poll_revised'").all()).toHaveLength(1);
    const moved = [calendar[0]!, { ...calendar[1]!, startDate: "1998-09-10T00:00:00Z" }];
    ingestSeason(db, year, await fetchSeason(client([completed], poll(40), moved), year));
    expect(db.query("SELECT * FROM calendar_revisions WHERE week=2").all()).toHaveLength(2);
    expect(db.query("SELECT * FROM snapshot_input_invalidations WHERE reason='calendar_changed'").all()).toHaveLength(1);
    expect(pollsAtCutoff(db, year, "1998-09-09T12:00:00Z")).toHaveLength(0);
    expect(db.query("SELECT * FROM snapshot_input_invalidations WHERE snapshot_key='weekly'").all()).toHaveLength(3);
    ingestSeason(db, year, await fetchSeason(client([{ ...completed, endDate: "1998-09-09T02:00:00Z" }], poll(40), moved), year));
    expect(gamesAtCutoff(db, year, "1998-09-16T00:00:00Z")).toEqual([]);
    expect(db.query("SELECT * FROM snapshot_input_invalidations WHERE reason='game_revised'").all()).toHaveLength(1);
    expect(db.query("PRAGMA foreign_key_check").all()).toEqual([]);
  } finally { db.close(); }
});

test("N+1 AP poll without a next regular calendar week publishes a pre-CCG final, never a later release", async () => {
  const db = await setup();
  try {
    const completed = { ...base, completed: true, status: "completed", homePoints: 14, awayPoints: 7 };
    const ccg = { ...completed, id: 12, seasonType: "postseason", week: 2,
      startDate: "1998-09-12T20:00:00Z", notes: "Conference Championship" };
    const calendar = [{ season: year, seasonType: "regular", week: 1,
      startDate: "1998-09-01T00:00:00Z", endDate: "1998-09-08T00:00:00Z" }];
    const rankings = [
      { season: year, seasonType: "regular", week: 2, polls: [{ poll: "AP Top 25", isFinal: false,
        ranks: [{ teamId: 1, school: "School 1", rank: 1, points: 10 }] }] },
      { season: year, seasonType: "postseason", week: 3, polls: [{ poll: "AP Top 25", isFinal: true,
        ranks: [{ teamId: 1, school: "School 1", rank: 1, points: 20 }] }] }
    ];
    const report = ingestSeason(db, year, await fetchSeason(client([completed, ccg], rankings, calendar), year));
    expect(report.coverage).toMatchObject({ pollReleaseTiming: false, selectionFreeze: true });
    // The postseason poll remains unmapped; the regular N+1 poll is bounded, not timestamped.
    const poll = db.query<{ id: string; effective_at_utc: string; released_at_utc: string | null; timing_provenance: string }, []>(
      "SELECT id,effective_at_utc,released_at_utc,timing_provenance FROM poll_releases WHERE provider_season_type='regular'").get()!;
    expect(poll).toMatchObject({ effective_at_utc: "1998-09-12T20:00:00.000Z",
      released_at_utc: null, timing_provenance: "derived_pre_ccg_cutoff" });
    expect(derivePollTiming(3, "postseason", calendar as never, "1998-09-12T20:00:00.000Z")).toBeNull();
    expect(pollTimingConvention(2, "regular", calendar as never, "1998-09-12T20:00:00.000Z").provenance)
      .toBe("derived_pre_ccg_cutoff");
    const result = rebuildSnapshots(db, year, "1998-09-20T00:00:00.000Z");
    expect(result.published).toContain("1998:selection-final");
    expect(result.incomplete.some(gap => gap.key === "1998:selection-final")).toBe(false);
    const final = db.query<{ poll_release_id: string; coverage_json: string }, []>(
      "SELECT poll_release_id,coverage_json FROM snapshots WHERE snapshot_key='1998:selection-final'").get()!;
    expect(final.poll_release_id).toBe(poll.id);
    expect(JSON.parse(final.coverage_json).poll.timingProvenance).toBe("derived_pre_ccg_cutoff");
    expect(db.query<{ game_id: string }, []>("SELECT game_id FROM snapshot_games WHERE snapshot_key='1998:selection-final'").all()
      .map(row => row.game_id)).toEqual(["cfbd:11"]);
    db.query("UPDATE poll_releases SET released_at_utc='1998-09-13T00:00:00.000Z' WHERE id=?").run(poll.id);
    expect(rebuildSnapshots(db, year, "1998-09-20T00:00:00.000Z").incomplete.find(g => g.key === "1998:selection-final")?.reasons)
      .toContain("missing corresponding pre-CCG poll release");
    expect(publishedSnapshot(db, "1998:selection-final")?.revision).toBe(1);
  } finally { db.close(); }
});

test("missing previously observed game is a schedule gap, not a cancellation", async () => {
  const db = await setup();
  try {
    const second = { ...base, id: 12, startDate: "1998-09-06T20:00:00Z" };
    ingestSeason(db, year, await fetchSeason(client([base, second]), year));
    const before = db.query<{ generation: number }, []>("SELECT generation FROM season_input_generations WHERE season=1998").get()!.generation;
    const report = ingestSeason(db, year, await fetchSeason(client([base]), year));
    expect(report.coverage.schedule).toBe(false);
    expect(db.query<{ status: string }, []>("SELECT status FROM games WHERE id='cfbd:12'").get()?.status).toBe("scheduled");
    expect(db.query<{ generation: number }, []>("SELECT generation FROM season_input_generations WHERE season=1998").get()!.generation).toBe(before + 1);
    expect(ingestSeason(db, year, await fetchSeason(client([base, second]), year)).coverage.schedule).toBe(true);
  } finally { db.close(); }
});

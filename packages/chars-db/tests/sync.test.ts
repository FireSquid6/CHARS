import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createClient } from "chars-cfbd";
import { openDatabase } from "../src/index";
import { fetchSeason } from "../src/ingest";
import { migrate } from "../src/migrate";
import { publishedSnapshot } from "../src/snapshots";
import { claimSync, scheduledKey, syncData, syncHealth } from "../src/sync";
import type { SeasonInput } from "../src/ingest";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
async function setup() {
  const dir = mkdtempSync("/tmp/opencode/chars-sync-"); dirs.push(dir);
  const path = join(dir, "db.sqlite");
  const db = openDatabase({ path }); await migrate(db);
  return { db, peer: openDatabase({ path }) };
}
const year = 1998;
const week = { season: year, seasonType: "regular", week: 1, startDate: "1998-09-01T00:00:00Z", endDate: "1998-09-08T00:00:00Z" };
const game = { id: 10, season: year, week: 1, seasonType: "regular", startDate: "1998-09-05T20:00:00Z",
  completed: false, status: "scheduled", homeId: 1, awayId: 2, homeTeam: "One", awayTeam: "Two",
  homePoints: 0, awayPoints: 0, homeClassification: "fbs", awayClassification: "fbs", notes: null, playoff: null };
const teams = [1, 2].map(id => ({ id, school: id === 1 ? "One" : "Two", classification: "fbs",
  conference: "Test", abbreviation: `T${id}` }));
async function input(games: unknown[] = [game], polls: unknown[] = [], calendar: unknown[] = [week]): Promise<SeasonInput> {
  const client = createClient({ apiKey: "offline", fetch: async url => {
    const path = new URL(url.toString()).pathname;
    return Response.json(path === "/games" ? new URL(url.toString()).searchParams.get("classification") === "fbs" ? games : [] :
      path === "/rankings" ? polls : path === "/calendar" ? calendar : teams);
  } });
  return fetchSeason(client, year);
}
const manual = (key: string, fetch: () => Promise<SeasonInput>) => ({ key: `manual:${key}`, currentSeason: year, recentSeasons: 0, fetch: async () => fetch() });

test("Chicago daily key is unique across both fall-back hours and crosses spring offset", () => {
  expect(scheduledKey(new Date("2026-11-01T05:30:00Z"))).toBe("daily:2026-11-01");
  expect(scheduledKey(new Date("2026-11-01T07:30:00Z"))).toBe("daily:2026-11-01");
  expect(scheduledKey(new Date("2026-03-08T05:30:00Z"))).toBe("daily:2026-03-07");
  expect(scheduledKey(new Date("2026-03-08T06:30:00Z"))).toBe("daily:2026-03-08");
});

test("overlapping connections, idempotent replay, expiry recovery and unique successful key", async () => {
  const { db, peer } = await setup();
  try {
    const source = await input();
    let unblock!: () => void;
    const gate = new Promise<void>(resolve => { unblock = resolve; });
    const running = syncData(db, { ...manual("first", async () => source), afterClaim: () => gate });
    expect(claimSync(peer, "manual:other")).toBeNull();
    unblock(); await running;
    const first = publishedSnapshot(db, "1998:week:1");
    expect(first).not.toBeNull();
    expect((await syncData(peer, manual("first", async () => { throw Error("must not fetch"); }))).skipped).toBe(true);
    await syncData(peer, manual("repeat", async () => source));
    expect(publishedSnapshot(db, "1998:week:1")?.revision).toBe(first?.revision);
    expect(db.query("SELECT * FROM game_revisions").all()).toHaveLength(1);
    expect(claimSync(db, "manual:orphan")).not.toBeNull();
    db.query("UPDATE job_leases SET expires_at_utc='2000-01-01T00:00:00.000Z'").run();
    expect(claimSync(peer, "manual:recover")).not.toBeNull();
    expect(db.query<{ state: string }, []>("SELECT state FROM sync_runs WHERE scheduled_key='manual:orphan'").get()?.state).toBe("failure");
  } finally { peer.close(); db.close(); }
});

test("late score and correction revise snapshots; failed fetch preserves prior revision", async () => {
  const { db, peer } = await setup();
  try {
    await syncData(db, manual("initial", () => input()));
    const first = publishedSnapshot(db, "1998:week:1")!;
    await expect(syncData(db, manual("bad", async () => { throw Error("provider outage"); }))).rejects.toThrow("provider outage");
    expect(publishedSnapshot(db, "1998:week:1")?.revision).toBe(first.revision);
    expect(db.query<{ state: string }, []>("SELECT state FROM sync_runs WHERE scheduled_key='manual:bad'").get()?.state).toBe("failure");
    await syncData(peer, manual("late", () => input([{ ...game, completed: true, status: "completed", homePoints: 14, awayPoints: 7 }])));
    const second = publishedSnapshot(db, "1998:week:1")!;
    expect(second.revision).toBeGreaterThan(first.revision);
    await syncData(db, manual("correction", () => input([{ ...game, completed: true, status: "completed", homePoints: 7, awayPoints: 14 }])));
    expect(publishedSnapshot(db, "1998:week:1")?.revision).toBeGreaterThan(second.revision);
    expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM scenario_work_queue").get()!.count).toBeGreaterThan(1);
  } finally { peer.close(); db.close(); }
});

test("poll and calendar revisions invalidate dependent weekly snapshot; empty failure retains data", async () => {
  const { db, peer } = await setup();
  try {
    const final = { ...game, completed: true, status: "completed", homePoints: 10, awayPoints: 7 };
    const poll = (rank: number) => [{ season: year, seasonType: "regular", week: 2,
      polls: [{ poll: "AP Top 25", ranks: [{ teamId: 1, school: "One", rank, points: 25 }] }] }];
    const weeks = [week, { ...week, week: 2, startDate: "1998-09-09T00:00:00Z", endDate: "1998-09-16T00:00:00Z" }];
    await syncData(db, manual("poll-first", () => input([final], poll(1), weeks)));
    const first = publishedSnapshot(db, "1998:week:1")!;
    await syncData(peer, manual("poll-correction", () => input([final], poll(2), weeks)));
    const second = publishedSnapshot(db, "1998:week:1")!;
    expect(second.revision).toBeGreaterThan(first.revision);
    await syncData(db, manual("calendar-correction", () => input([final], poll(2), [
      { ...week, endDate: "1998-09-08T12:00:00Z" }, weeks[1]
    ])));
    expect(publishedSnapshot(db, "1998:week:1")?.revision).toBeGreaterThan(second.revision);
    await expect(syncData(db, manual("empty", () => input([], poll(2), weeks)))).rejects.toThrow("Empty game response");
    expect(db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM games").get()?.count).toBe(1);
  } finally { peer.close(); db.close(); }
});

test("late week correction verifies and restores unaffected earlier publication without revision", async () => {
  const { db, peer } = await setup();
  try {
    const firstGame = { ...game, completed: true, status: "completed", homePoints: 7, awayPoints: 3 };
    const later = { ...game, id: 11, week: 2, startDate: "1998-09-12T20:00:00Z" };
    const weeks = [week, { ...week, week: 2, startDate: "1998-09-09T00:00:00Z", endDate: "1998-09-16T00:00:00Z" }];
    await syncData(db, manual("before-later", () => input([firstGame, later], [], weeks)));
    const early = publishedSnapshot(db, "1998:week:1")!;
    const second = publishedSnapshot(db, "1998:week:2")!;
    await syncData(peer, manual("late-week", () => input([firstGame, { ...later, completed: true,
      status: "completed", homePoints: 13, awayPoints: 10 }], [], weeks)));
    expect(publishedSnapshot(db, "1998:week:1")).toEqual(early);
    expect(db.query<{ state: string }, []>("SELECT state FROM snapshot_publications WHERE snapshot_key='1998:week:1'").get()?.state)
      .toBe("current");
    expect(publishedSnapshot(db, "1998:week:2")?.revision).toBeGreaterThan(second.revision);
  } finally { peer.close(); db.close(); }
});

test("scheduled retry retains Sunday's planned range on Monday; health separates last success", async () => {
  const { db, peer } = await setup();
  try {
    await syncData(db, manual("healthy", () => input()));
    const sunday = "daily:2026-10-18";
    claimSync(db, sunday, new Date(), { current: 2026, recent: 2, timezone: "America/Chicago" });
    db.query("UPDATE job_leases SET expires_at_utc='2000-01-01T00:00:00.000Z'").run();
    let fetched = 0;
    await expect(syncData(peer, { key: sunday, currentSeason: 1998, recentSeasons: 0,
      fetch: async year => { fetched = year; throw Error("offline"); } })).rejects.toThrow("offline");
    expect(fetched).toBe(2024);
    expect(syncHealth(db).lastSuccess?.scheduled_key).toBe("manual:healthy");
    expect(syncHealth(db).lastRun?.scheduled_key).toBe(sunday);
  } finally { peer.close(); db.close(); }
});

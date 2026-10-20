import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCfbdClient } from "../src/cfbd";
import { migrateDatabase } from "../src/migrate";
import { openDatabase } from "../src/database";
import { syncSeason, withLease } from "../src/jobs";
import { pollFingerprint, readPublished } from "../src/snapshots";
import { auditedSeason } from "../src/source";
import { buildSnapshots } from "../src/snapshots";

test("syncSeason publishes only validated changes and preserves publication on failure", async () => {
  const season = 2024, root = await mkdtemp(join(tmpdir(), "chars-sync-fixture-"));
  const databasePath = join(root, "data.sqlite"), cache = join(root, "cache");
  let homePoints = 3, awayPoints = 0, invalid = false, empty = false, missingGame = false;
  let requests = 0;
  let before: ReturnType<typeof openDatabase> | undefined;
  try {
    migrateDatabase(databasePath);
    const connection = openDatabase(databasePath);
    before = connection;
    const tables = () => connection.sqlite.query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all().map(row => row.name);
    const originalTables = tables();
    const client = createCfbdClient({ key: "fixture-secret", fetcher: async (url, init) => {
      requests++;
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer fixture-secret");
      const path = new URL(String(url)).pathname;
      if (path === "/teams/fbs" || path === "/teams") return Response.json([1, 2].map(id => ({ id, school: id === 1 ? "A" : "B", abbreviation: id === 1 ? "A" : "B", classification: "fbs", conference: "Fixture" })));
      if (path === "/games") return Response.json(empty ? [] : [
        { id: 101, season, week: 1, seasonType: "regular", startDate: "2024-09-01T00:00:00Z", homeId: 1, awayId: 2, homeTeam: "A", awayTeam: "B", homePoints, awayPoints, completed: true },
        { id: 102, season, week: 2, seasonType: invalid ? "postseason" : "regular", startDate: "2024-09-08T00:00:00Z", homeId: 2, awayId: 1, homeTeam: "B", awayTeam: "A", homePoints: null, awayPoints: null, completed: false }
      ].filter(g => !missingGame || g.id !== 102));
      if (path === "/rankings") return Response.json([{ season, seasonType: "regular", week: 2, polls: ["AP Top 25", "CFP"].map(poll => ({ poll, ranks: [{ teamId: 1, rank: 1 }, { teamId: 2, rank: 2 }] })) }]);
      if (path === "/calendar") return Response.json([
        { season, seasonType: "regular", week: 1, startDate: "2024-08-31T00:00:00Z", endDate: "2024-09-02T00:00:00Z" },
        { season, seasonType: "regular", week: 2, startDate: "2024-09-07T00:00:00Z", endDate: "2024-09-09T00:00:00Z" }
      ]);
      throw new Error("Unexpected fixture path");
    } });
    const options = { client, databasePath };
    expect(await syncSeason(season, cache, options)).toEqual({ changed: true, coverage: [] });
    const first = await readPublished(join(cache, "snapshots"), season);
    const manifest = () => readFile(join(cache, "snapshots", String(season), "current.json"), "utf8");
    const firstManifest = await manifest();
    expect(first.find(s => s.week === 1)?.includedGameIds).toEqual(["101"]);
    expect(await syncSeason(season, cache, options)).toEqual({ changed: false, coverage: [] });
    expect(await manifest()).toBe(firstManifest);
    expect(await readPublished(join(cache, "snapshots"), season)).toEqual(first);

    const calendarPath = join(cache, "source", `${season}-calendar.json`);
    const verified = { verified: true, freezeUtc: "2024-09-07T00:00:00.000Z", firstCcgUtc: "2024-09-07T12:00:00.000Z" };
    await writeFile(calendarPath, JSON.stringify(verified));
    expect((await syncSeason(season, cache, options)).changed).toBe(false);
    expect((await readPublished(join(cache, "snapshots"), season)).some(s => s.kind === "selection_final")).toBe(false);
    const timingPoll = (await auditedSeason(connection.sqlite, season, cache)).source.polls
      .find(poll => poll.release.id === "cfbd:2024:regular:2:cfp")!;
    await writeFile(join(cache, "source", `${season}-poll-timing.json`), JSON.stringify({
      [timingPoll.release.id]: { reviewedBy: "fixture-reviewer", reviewedAtUtc: "2024-09-10T00:00:00.000Z",
        source: "independent fixture publication record", releasedAtUtc: "2024-09-07T00:00:00.000Z",
        pollFingerprint: pollFingerprint(timingPoll) }
    }));
    expect((await syncSeason(season, cache, options)).changed).toBe(false);
    const final = (await readPublished(join(cache, "snapshots"), season)).find(s => s.kind === "selection_final");
    expect(final?.includedGameIds).toEqual(["101"]);
    expect(final?.pollReleaseId).toBe("cfbd:2024:regular:2:cfp");
    const finalManifest = await manifest();
    expect((await syncSeason(season, cache, options)).changed).toBe(false);
    expect(await manifest()).toBe(finalManifest);

    await writeFile(calendarPath, JSON.stringify({ ...verified, verified: false }));
    expect((await syncSeason(season, cache, options)).changed).toBe(false);
    expect((await readPublished(join(cache, "snapshots"), season)).some(s => s.kind === "selection_final")).toBe(false);
    await writeFile(calendarPath, JSON.stringify(verified));
    expect((await syncSeason(season, cache, options)).changed).toBe(false);
    expect((await readPublished(join(cache, "snapshots"), season)).some(s => s.kind === "selection_final")).toBe(true);
    const beforeInvalid = await manifest();

    invalid = true; // Ambiguous classification must not replace the prior publication.
    await expect(syncSeason(season, cache, options)).rejects.toThrow("coverage gaps");
    expect(await manifest()).toBe(beforeInvalid);
    invalid = false;
    homePoints = 0; awayPoints = 3;
    expect((await syncSeason(season, cache, options)).changed).toBe(true);
    const revised = await readPublished(join(cache, "snapshots"), season);
    expect(await manifest()).not.toBe(firstManifest);
    expect(revised.find(s => s.week === 1)?.key).not.toBe(first.find(s => s.week === 1)?.key);
    expect(revised.find(s => s.week === 1)?.rankings).not.toEqual(first.find(s => s.week === 1)?.rankings);
    expect(revised.find(s => s.kind === "selection_final")?.includedGameIds).toEqual(["101"]);
    expect(revised.find(s => s.kind === "selection_final")?.key).not.toBe(final?.key);
    const revisedManifest = await manifest();

    empty = true;
    await expect(syncSeason(season, cache, options)).rejects.toThrow("Empty game response");
    expect(await manifest()).toBe(revisedManifest);
    empty = false;
    await rm(join(cache, "snapshots", String(season), "current.json"));
    expect((await syncSeason(season, cache, options)).changed).toBe(false);
    expect((await readPublished(join(cache, "snapshots"), season)).some(s => s.kind === "selection_final")).toBe(true);

    // A source row disappearing is not a cancellation. The *manual* rebuild path
    // receives the audit gap too, despite still having a verified calendar.
    const restoredManifest = await manifest();
    missingGame = true;
    await expect(syncSeason(season, cache, options)).rejects.toThrow("coverage gaps");
    expect(await manifest()).toBe(restoredManifest);
    const audited = await auditedSeason(connection.sqlite, season, cache);
    expect(audited.source.coverage.some(gap => gap.includes("game 102 absent"))).toBe(true);
    expect(buildSnapshots(audited.source, audited.calendar).some(s => s.kind === "selection_final")).toBe(false);
    const journal = join(cache, "source", `${season}-pending.json`);
    await writeFile(journal, JSON.stringify({ phase: "prepared" }));
    await expect(auditedSeason(connection.sqlite, season, cache)).rejects.toThrow("operator reconciliation");
    await expect(syncSeason(season, cache, options)).rejects.toThrow("operator review");
    expect(await manifest()).toBe(restoredManifest);
    expect(connection.sqlite.query<{ home_score: number; away_score: number }, []>("SELECT home_score, away_score FROM games WHERE game_id=101").get()).toEqual({ home_score: 0, away_score: 3 });
    expect(tables()).toEqual(originalTables);
    expect(requests).toBeGreaterThan(0);
  } finally { before?.close(); await rm(root, { recursive: true, force: true }); }
});

test("a stale mtime cannot steal a lease held by a still-live owner", async () => {
  const root = await mkdtemp(join(tmpdir(), "chars-lease-fixture-"));
  let started!: () => void, finish!: () => void;
  const entered = new Promise<void>(resolve => { started = resolve; });
  const held = new Promise<void>(resolve => { finish = resolve; });
  try {
    const running = withLease(root, async () => { started(); await held; });
    await entered;
    const past = new Date(Date.now() - 4 * 60 * 60 * 1000);
    await utimes(join(root, "sync.lock"), past, past);
    await expect(withLease(root, async () => { throw new Error("Concurrent writer entered"); })).rejects.toThrow("still alive");
    finish();
    await running;
  } finally { finish?.(); await rm(root, { recursive: true, force: true }); }
});

test("active season sync publishes preseason/partial only as of local day and proposes, never verifies, a freeze", async () => {
  const season = 2026, root = await mkdtemp(join(tmpdir(), "chars-live-sync-"));
  const databasePath = join(root, "data.sqlite"), cache = join(root, "cache");
  try {
    migrateDatabase(databasePath);
    const client = createCfbdClient({ key: "fixture-secret", fetcher: async url => {
      const path = new URL(String(url)).pathname;
      if (path === "/teams/fbs" || path === "/teams") return Response.json([1, 2].map(id => ({ id, school: id === 1 ? "A" : "B", abbreviation: "F", classification: "fbs", conference: "Fixture" })));
      if (path === "/games") return Response.json([
        { id: 201, season, week: 1, seasonType: "regular", startDate: "2026-09-01T00:00:00Z", homeId: 1, awayId: 2, homeTeam: "A", awayTeam: "B", homePoints: 7, awayPoints: 0, completed: true },
        { id: 202, season, week: 2, seasonType: "regular", startDate: "2026-09-08T00:00:00Z", homeId: 2, awayId: 1, homeTeam: "B", awayTeam: "A", homePoints: null, awayPoints: null, completed: false },
        { id: 203, season, week: 4, seasonType: "postseason", startDate: "2026-09-20T00:00:00Z", homeId: 1, awayId: 2, homeTeam: "A", awayTeam: "B", homePoints: null, awayPoints: null, completed: false, notes: "Conference Championship" }
      ]);
      if (path === "/rankings") return Response.json([]);
      if (path === "/calendar") return Response.json([
        { season, seasonType: "regular", week: 1, startDate: "2026-08-31T00:00:00Z", endDate: "2026-09-02T00:00:00Z" },
        { season, seasonType: "regular", week: 2, startDate: "2026-09-07T00:00:00Z", endDate: "2026-09-09T00:00:00Z" }
      ]);
      throw new Error("Unexpected fixture path");
    } });
    const options = { client, databasePath };
    const syncAt = (utc: string) => syncSeason(season, cache, { ...options, now: new Date(utc) });
    const snapshots = () => readPublished(join(cache, "snapshots"), season);
    const manifest = () => readFile(join(cache, "snapshots", String(season), "current.json"), "utf8");

    expect((await syncAt("2026-08-15T10:00:00Z")).changed).toBe(true);
    expect((await snapshots()).map(s => [s.kind, s.week, s.includedGameIds])).toEqual([["partial", null, []]]);
    const candidate = JSON.parse(await readFile(join(cache, "source", `${season}-calendar-candidate.json`), "utf8"));
    expect(candidate.candidate).toEqual({ freezeUtc: "2026-09-09T00:00:00.000Z", firstCcgUtc: "2026-09-20T00:00:00.000Z", verified: false, provenance: "cfbd-calendar-and-explicit-ccg" });
    const preseasonManifest = await manifest();
    expect((await syncAt("2026-08-15T11:00:00Z")).changed).toBe(false);
    expect(await manifest()).toBe(preseasonManifest);

    expect((await syncAt("2026-09-02T12:00:00Z")).changed).toBe(false);
    expect((await snapshots()).map(s => [s.kind, s.week, s.includedGameIds])).toEqual([["partial", 1, []]]);
    const partialManifest = await manifest();
    expect((await syncAt("2026-09-02T13:00:00Z")).changed).toBe(false);
    expect(await manifest()).toBe(partialManifest);
    expect((await syncAt("2026-09-07T23:00:00Z")).changed).toBe(false);
    expect((await snapshots()).map(s => [s.kind, s.week])).toEqual([["partial", 1]]);
    const beforeSameDayWeekBoundary = await manifest();
    expect((await syncAt("2026-09-08T00:01:00Z")).changed).toBe(false);
    expect(await manifest()).not.toBe(beforeSameDayWeekBoundary);
    expect((await syncAt("2026-09-08T12:00:00Z")).changed).toBe(false);
    expect((await snapshots()).map(s => [s.kind, s.week, s.includedGameIds])).toEqual([["week_final", 1, ["201"]], ["partial", 2, ["201"]]]);
    expect((await snapshots()).some(s => s.kind === "selection_final")).toBe(false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

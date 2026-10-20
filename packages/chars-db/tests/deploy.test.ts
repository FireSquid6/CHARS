import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { backup, restore, verifyDatabase } from "../src/backup";
import { parseBackfillArgs } from "../src/backfill";
import { openDatabase } from "../src/index";
import { currentFootballSeason } from "../src/ingest";
import { migrate } from "../src/migrate";
import { missedReconciliationKey, retryableKey, runSchedule } from "../src/schedule";
import { claimSync, planFor, scheduledKey, syncData } from "../src/sync";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
test("deployment binds Next explicitly to loopback and systemd parses the configured midnight across DST", () => {
  const service = readFileSync(join(import.meta.dir, "../../../deploy/chars-site.service"), "utf8");
  expect(service).toContain("ExecStart=/usr/local/bin/bun run start --hostname 127.0.0.1");
  const cli = spawnSync("bun", ["run", "start", "--help"], { cwd: join(import.meta.dir, "../../.."), encoding: "utf8" });
  expect(cli.status).toBe(0);
  expect(cli.stdout + cli.stderr).toContain("--hostname <hostname>");
  const timer = readFileSync(join(import.meta.dir, "../../../deploy/chars-sync.timer"), "utf8");
  const calendar = /^OnCalendar=(.+)$/m.exec(timer)?.[1];
  expect(calendar).toBe("*-*-* 00:00:00 America/Chicago");
  for (const [base, utc] of [["2026-03-08T05:00:00Z", "2026-03-08 06:00:00 UTC"],
    ["2026-11-01T04:00:00Z", "2026-11-01 05:00:00 UTC"]]) {
    const check = spawnSync("systemd-analyze", ["calendar", `--base-time=${base}`, calendar!], { encoding: "utf8" });
    if (check.error && (check.error as NodeJS.ErrnoException).code === "ENOENT") return; // non-systemd CI
    expect(check.status).toBe(0);
    expect(check.stdout).toContain(utc);
  }
});
async function setup() {
  const dir = mkdtempSync("/tmp/opencode/chars-deploy-"); dirs.push(dir);
  const path = join(dir, "db.sqlite"), db = openDatabase({ path });
  await migrate(db);
  return { dir, path, db };
}

test("WAL backup includes committed rows but excludes an uncommitted writer; restore requires an empty target", async () => {
  const { dir, path, db } = await setup();
  try {
    db.exec("CREATE TABLE backup_probe (id INTEGER PRIMARY KEY)");
    db.exec("INSERT INTO backup_probe VALUES (1)");
    expect(statSync(`${path}-wal`).size).toBeGreaterThan(0);
    const writer = openDatabase({ path });
    try {
      writer.exec("BEGIN IMMEDIATE; INSERT INTO backup_probe VALUES (2)");
      // VACUUM INTO reads a committed snapshot while another connection has WAL writes.
      const saved = join(dir, "backup.sqlite");
      await backup(path, saved);
      writer.exec("ROLLBACK");
      verifyDatabase(saved);
      await expect(backup(path, saved)).rejects.toThrow("already exists");
      await expect(restore(saved, path)).rejects.toThrow("empty");
      const recovered = join(dir, "restored.sqlite");
      await restore(saved, recovered);
      const restored = openDatabase({ path: recovered });
      try {
        expect(restored.query("SELECT id FROM backup_probe").all()).toEqual([{ id: 1 }]);
        expect(restored.query("SELECT version FROM schema_migrations").all()).not.toHaveLength(0);
        await migrate(restored); // restored schema remains migration-compatible
      } finally { restored.close(); }
    } finally { try { writer.exec("ROLLBACK"); } catch {} writer.close(); }
  } finally { db.close(); }
});

test("timer keys cross both DST boundaries once and stale scheduled runs are retryable", async () => {
  expect(scheduledKey(new Date("2026-03-08T05:59:59Z"))).toBe("daily:2026-03-07");
  expect(scheduledKey(new Date("2026-03-08T06:00:00Z"))).toBe("daily:2026-03-08");
  expect(scheduledKey(new Date("2026-11-01T04:59:59Z"))).toBe("daily:2026-10-31");
  expect(scheduledKey(new Date("2026-11-01T05:00:00Z"))).toBe("daily:2026-11-01");
  expect(scheduledKey(new Date("2026-11-02T05:59:59Z"))).toBe("daily:2026-11-01");
  expect(scheduledKey(new Date("2026-11-02T06:00:00Z"))).toBe("daily:2026-11-02");
  const { db } = await setup();
  try {
    const now = new Date("2026-11-02T08:15:00Z");
    claimSync(db, "daily:2026-11-01", new Date("2026-11-01T05:00:00Z"));
    expect(retryableKey(db, "daily:2026-11-02", now)).toBe("daily:2026-11-01");
    const keys: string[] = [];
    const report = await runSchedule(db, now, "America/Chicago", async (_db, options) => {
      keys.push(options.key);
      return { skipped: true, key: options.key };
    });
    expect(keys).toEqual(["daily:2026-11-02", "daily:2026-11-01"]);
    expect(report.results).toHaveLength(2);
    db.query("UPDATE sync_runs SET state='success' WHERE scheduled_key='daily:2026-11-01'").run();
    expect(retryableKey(db, "daily:2026-11-02", now)).toBeNull();
  } finally { db.close(); }
});

test("long downtime coalesces missed Sundays and retries older failed keys without a request stampede", async () => {
  const { db } = await setup();
  try {
    const now = new Date("2026-10-19T12:00:00Z"), today = "daily:2026-10-19";
    claimSync(db, "daily:2026-09-27", new Date("2026-09-27T05:00:00Z"));
    db.query("UPDATE job_leases SET expires_at_utc='2000-01-01T00:00:00Z'").run();
    expect(missedReconciliationKey(db, today, now, "America/Chicago")).toBe("daily:2026-10-18");
    const keys: string[] = [];
    await runSchedule(db, now, "America/Chicago", async (_db, options) => {
      keys.push(options.key);
      return { skipped: true, key: options.key };
    });
    expect(keys).toEqual([today, "daily:2026-10-18"]);
    claimSync(db, "daily:2026-10-18", now);
    db.query("UPDATE sync_runs SET state='success' WHERE scheduled_key='daily:2026-10-18'").run();
    expect(missedReconciliationKey(db, today, now, "America/Chicago")).toBeNull();
    expect(retryableKey(db, today, now)).toBe("daily:2026-09-27");
  } finally { db.close(); }
});

test("freshly failed current day cools down instead of fetching every timer wakeup", async () => {
  const { db } = await setup();
  try {
    const now = new Date("2026-10-19T12:00:00Z");
    claimSync(db, "daily:2026-10-19", now);
    db.query("UPDATE sync_runs SET state='failure' WHERE scheduled_key='daily:2026-10-19'").run();
    const keys: string[] = [];
    await runSchedule(db, new Date(now.getTime() + 30 * 60000), "America/Chicago", async (_db, options) => {
      keys.push(options.key);
      return { skipped: true, key: options.key };
    });
    expect(keys).toEqual(["daily:2026-10-18"]); // one missed-Sunday catch-up, no current-day retry yet
  } finally { db.close(); }
});

test("restore refuses orphan WAL and SHM, even without a main database", async () => {
  const { dir, path, db } = await setup();
  try {
    const saved = join(dir, "safe.sqlite"), destination = join(dir, "new.sqlite");
    await backup(path, saved);
    await Bun.write(`${destination}-wal`, "orphan");
    await expect(restore(saved, destination)).rejects.toThrow("including -wal and -shm");
    unlinkSync(`${destination}-wal`);
    await Bun.write(`${destination}-shm`, "orphan");
    await expect(restore(saved, destination)).rejects.toThrow("including -wal and -shm");
  } finally { db.close(); }
});

test("configured timezone controls local June 30 football season and replay keeps its original plan", async () => {
  const now = new Date("2026-07-01T06:30:00Z"); // June 30 23:30 in Los Angeles
  expect(currentFootballSeason(now, "America/Los_Angeles")).toBe(2025);
  expect(parseBackfillArgs(["--season", "CURRENT"], now, "America/Los_Angeles")).toEqual([2025]);
  expect(scheduledKey(now, "America/Los_Angeles")).toBe("daily:2026-06-30");
  expect(planFor("manual:la", now, "America/Los_Angeles")).toEqual({ current: 2025, recent: 2, timezone: "America/Los_Angeles" });
  expect(planFor("daily:2026-06-30", new Date("2026-07-03T00:00:00Z"), "America/Los_Angeles"))
    .toEqual({ current: 2025, recent: 0, timezone: "America/Los_Angeles" });
  const { db } = await setup();
  try {
    const key = scheduledKey(now, "America/Los_Angeles");
    const first = claimSync(db, key, now, { current: 2025, recent: 0, timezone: "America/Los_Angeles" });
    expect(first).not.toBeNull();
    db.query("UPDATE job_leases SET expires_at_utc='2000-01-01T00:00:00Z'").run();
    let fetched = 0;
    await expect(syncData(db, { key, timezone: "America/Chicago",
      fetch: async year => { fetched = year; throw Error("offline fixture"); } })).rejects.toThrow("offline fixture");
    expect(fetched).toBe(2025);
    const plan = db.query<{ planned_current_season: number; planned_timezone: string }, [string]>(
      "SELECT planned_current_season,planned_timezone FROM sync_runs WHERE scheduled_key=?").get(key);
    expect(plan).toEqual({ planned_current_season: 2025, planned_timezone: "America/Los_Angeles" });
    const manual = "manual:la-season-boundary";
    claimSync(db, manual, now, { current: currentFootballSeason(now, "America/Los_Angeles"),
      recent: 2, timezone: "America/Los_Angeles" });
    expect(db.query<{ planned_current_season: number }, [string]>(
      "SELECT planned_current_season FROM sync_runs WHERE scheduled_key=?").get(manual)?.planned_current_season).toBe(2025);
  } finally { db.close(); }
});

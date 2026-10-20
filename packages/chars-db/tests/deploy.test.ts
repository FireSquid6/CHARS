import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { backup, restore, verifyDatabase } from "../src/backup";
import { openDatabase } from "../src/index";
import { migrate } from "../src/migrate";
import { retryableKey, runSchedule } from "../src/schedule";
import { claimSync, scheduledKey } from "../src/sync";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true }); });
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
    const now = new Date("2026-11-02T06:15:00Z");
    claimSync(db, "daily:2026-11-01", new Date("2026-11-02T05:00:00Z"));
    expect(retryableKey(db, "daily:2026-11-02", now)).toBe("daily:2026-11-01");
    const keys: string[] = [];
    const report = await runSchedule(db, now, "America/Chicago", async (_db, options) => {
      keys.push(options.key);
      return { skipped: true, key: options.key };
    });
    expect(keys).toEqual(["daily:2026-11-01", "daily:2026-11-02"]);
    expect(report.results).toHaveLength(2);
    db.query("UPDATE sync_runs SET state='success' WHERE scheduled_key='daily:2026-11-01'").run();
    expect(retryableKey(db, "daily:2026-11-02", now)).toBeNull();
  } finally { db.close(); }
});

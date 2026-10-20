/** One bounded timer activation; systemd owns the clock and invokes this outside Next.js. */
import type { Database } from "bun:sqlite";
import { configFromEnv, openDatabase } from "./index";
import { migrate } from "./migrate";
import { scheduledKey, syncData, syncHealth } from "./sync";

export function retryableKey(db: Database, today: string, now = new Date()): string | null {
  const row = db.query<{ scheduled_key: string }, [string, string]>(`SELECT scheduled_key FROM sync_runs
    WHERE scheduled_key LIKE 'daily:%' AND scheduled_key < ? AND state IN ('running','failure')
    AND started_at_utc >= ? ORDER BY scheduled_key DESC LIMIT 1`)
    .get(today, new Date(now.getTime() - 48 * 3600000).toISOString());
  return row?.scheduled_key ?? null;
}

export async function runSchedule(db: Database, now = new Date(), timezone = "America/Chicago",
  sync: typeof syncData = syncData) {
  const today = scheduledKey(now, timezone);
  const prior = retryableKey(db, today, now);
  // Catch-up is at most one prior failed day per wakeup. Full-season reconciliation
  // means missing dates do not require replaying one provider request per day.
  const results: unknown[] = [];
  for (const key of prior ? [prior, today] : [today]) {
    try { results.push(await sync(db, { key, now, timezone })); }
    catch (error) {
      results.push({ key, error: error instanceof Error ? error.message : "Sync failed" });
    }
  }
  return { results, health: syncHealth(db) };
}

if (import.meta.main) {
  try {
    const db = openDatabase(configFromEnv());
    try {
      await migrate(db);
      const result = await runSchedule(db, new Date(), process.env.SYNC_TIMEZONE ?? "America/Chicago");
      console.log(JSON.stringify(result));
      if (result.results.some(item => typeof item === "object" && item !== null && "error" in item)) process.exitCode = 1;
    } finally { db.close(); }
  } catch (error) { console.error(error instanceof Error ? error.message : "Scheduler failed"); process.exitCode = 1; }
}

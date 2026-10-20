/** One bounded timer activation; systemd owns the clock and invokes this outside Next.js. */
import type { Database } from "bun:sqlite";
import { configFromEnv, openDatabase } from "./index";
import { migrate } from "./migrate";
import { scheduledKey, syncData, syncHealth } from "./sync";

export function retryableKey(db: Database, today: string, now = new Date()): string | null {
  const row = db.query<{ scheduled_key: string }, [string, string]>(`SELECT scheduled_key FROM sync_runs
    WHERE scheduled_key LIKE 'daily:%' AND scheduled_key < ? AND state IN ('running','failure')
    AND started_at_utc <= ? ORDER BY scheduled_key DESC LIMIT 1`)
    .get(today, new Date(now.getTime() - 2 * 3600000).toISOString());
  return row?.scheduled_key ?? null;
}

/** Last missed Sunday, coalesced into one reconciliation regardless of downtime length. */
export function missedReconciliationKey(db: Database, today: string, now: Date, timezone: string): string | null {
  const date = new Date(`${today.slice(6)}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() - date.getUTCDay());
  const sunday = `daily:${date.toISOString().slice(0, 10)}`;
  if (sunday === today) return null; // Today's normal scheduled plan already reconciles recent seasons.
  const recent = db.query<{ scheduled_key: string | null; started_at_utc: string }, []>(`SELECT scheduled_key,started_at_utc FROM sync_runs
    WHERE state='success' AND planned_recent_seasons>=2 ORDER BY started_at_utc DESC LIMIT 1`).get();
  const sundayRun = db.query<{ state: string; started_at_utc: string }, [string]>(
    "SELECT state,started_at_utc FROM sync_runs WHERE scheduled_key=?").get(sunday);
  // On a brand-new installation there is no missed obligation to recover.
  const history = db.query("SELECT 1 FROM sync_runs LIMIT 1").get();
  if (!history || (recent && scheduledKey(new Date(recent.started_at_utc), timezone) >= sunday)) return null;
  if (sundayRun?.state === "success" || (sundayRun && Date.parse(sundayRun.started_at_utc) > now.getTime() - 2 * 3600000)) return null;
  return sunday;
}

export async function runSchedule(db: Database, now = new Date(), timezone = "America/Chicago",
  sync: typeof syncData = syncData) {
  const today = scheduledKey(now, timezone);
  const prior = missedReconciliationKey(db, today, now, timezone) ?? retryableKey(db, today, now);
  const todayRun = db.query<{ state: string; started_at_utc: string }, [string]>(
    "SELECT state,started_at_utc FROM sync_runs WHERE scheduled_key=?").get(today);
  const todayCoolingDown = todayRun?.state === "failure" &&
    Date.parse(todayRun.started_at_utc) > now.getTime() - 2 * 3600000;
  // At most two runs per wakeup. A missed Sunday fetches recent seasons once,
  // even after long downtime; old failed keys retain their original plan.
  const results: unknown[] = [];
  for (const key of [
    ...(todayCoolingDown ? [] : [today]),
    ...(prior ? [prior] : [])
  ]) {
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

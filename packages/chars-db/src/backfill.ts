import { createClient } from "chars-cfbd";
import { configFromEnv, openDatabase } from "./index";
import { currentFootballSeason, fetchSeason, ingestSeason } from "./ingest";
import { migrate } from "./migrate";

export function parseBackfillArgs(args: string[], now = new Date()): number[] {
  const options = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    if (!["--season", "--from", "--to"].includes(args[i] ?? "") || !args[i + 1] || options.has(args[i]!)) {
      throw new Error("Usage: bun run data:backfill --season YEAR | --from YEAR --to CURRENT|YEAR");
    }
    options.set(args[i]!, args[i + 1]!);
  }
  if ((options.has("--season") && options.size !== 1) ||
    (!options.has("--season") && (options.size !== 2 || !options.has("--from") || !options.has("--to")))) {
    throw new Error("Usage: bun run data:backfill --season YEAR | --from YEAR --to CURRENT|YEAR");
  }
  const current = currentFootballSeason(now);
  function year(value: string | undefined): number {
    const result = value === "CURRENT" ? current : /^\d{4}$/.test(value ?? "") ? Number(value) : NaN;
    if (!Number.isSafeInteger(result) || result < 1998 || result > current) throw new Error(`Invalid season ${value}; expected 1998 through CURRENT (${current})`);
    return result;
  }
  const from = year(options.get("--season") ?? options.get("--from"));
  const to = year(options.get("--season") ?? options.get("--to"));
  if (from > to) throw new Error("--from must not exceed --to");
  return Array.from({ length: to - from + 1 }, (_, index) => from + index);
}

if (import.meta.main) {
  try {
    const years = parseBackfillArgs(process.argv.slice(2));
    const client = createClient(); // Fail before creating a database when the credential is missing.
    const db = openDatabase(configFromEnv());
    try {
      await migrate(db);
      for (const year of years) {
        const input = await fetchSeason(client, year);
        console.log(JSON.stringify(ingestSeason(db, year, input)));
      }
    } finally { db.close(); }
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Backfill failed");
    process.exitCode = 1;
  }
}

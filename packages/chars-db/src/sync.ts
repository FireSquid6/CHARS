import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { footballSeason, localKey, runDaily } from "./jobs";

export async function syncCli(args = process.argv.slice(2)) {
  const cache = process.env.CHARS_CACHE_PATH ?? ".cache", zone = process.env.SYNC_TIMEZONE ?? "America/Chicago";
  if (args.includes("--status")) {
    const lease = await stat(join(cache, "sync.lock")).catch(() => null);
    console.log(JSON.stringify({ lease: lease ? { createdAtUtc: lease.birthtime.toISOString(), staleAfterUtc: new Date(lease.mtimeMs + 3 * 60 * 60 * 1000).toISOString() } : null }));
    const files = await readdir(join(cache, "runs")).catch(() => []);
    for (const file of files.filter(f => f.endsWith(".json")).sort().slice(-10)) console.log(await readFile(join(cache, "runs", file), "utf8"));
  } else if (args.includes("--retry")) {
    const key = args[args.indexOf("--retry") + 1];
    if (!/^daily:\d{4}-\d{2}-\d{2}$/.test(key ?? "")) throw new Error("Usage: --retry daily:YYYY-MM-DD");
    const run = JSON.parse(await readFile(join(cache, "runs", `${key}.json`), "utf8")) as { seasons: number[] };
    await runDaily(cache, key!, run.seasons, true);
  } else {
    const year = footballSeason(new Date(), zone);
    const seasons = args.includes("--manual") || new Intl.DateTimeFormat("en-US", { timeZone: zone, weekday: "short" }).format(new Date()) === "Sun" ? [year - 2, year - 1, year] : [year];
    await runDaily(cache, args.includes("--manual") ? `manual:${Date.now()}` : `daily:${localKey(new Date(), zone)}`, seasons);
  }
}
if (import.meta.main) await syncCli();

import { openDatabase } from "./database";
import { createCfbdClient } from "./cfbd";
import { ingest } from "./ingest";
import { withLease, footballSeason } from "./jobs";

if (import.meta.main) {
  const args = process.argv.slice(2), option = (name: string) => args[args.indexOf(name) + 1];
  const single = args.includes("--season"), first = Number(option(single ? "--season" : "--from"));
  const last = single ? first : option("--to") === "CURRENT" ? footballSeason() : Number(option("--to"));
  if (!Number.isSafeInteger(first) || !Number.isSafeInteger(last) || first < 1998 || last < first) throw new Error("Usage: data:backfill --season YEAR | --from 1998 --to CURRENT");
  const cache = process.env.CHARS_CACHE_PATH ?? ".cache";
  await withLease(cache, async () => {
    const client = createCfbdClient();
    const db = openDatabase();
    try { for (let year = first; year <= last; year++) { const result = await ingest(db.sqlite, year, await client.season(year), cache); console.log(`Season ${year}: ${JSON.stringify(result.counts)}; coverage gaps: ${result.coverage.length}`); } }
    finally { db.close(); }
  });
}

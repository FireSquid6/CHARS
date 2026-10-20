import { openDatabase } from "./database";
import { buildSnapshots, publishSnapshots } from "./snapshots";
import { auditedSeason } from "./source";

const index = process.argv.indexOf("--season");
const season = Number(process.argv[index + 1]);
if (index < 0 || !Number.isSafeInteger(season) || season < 1) throw new Error("Usage: bun run snapshots:rebuild --season YEAR [--as-of UTC_ISO]");
const asOfIndex = process.argv.indexOf("--as-of");
const asOf = asOfIndex < 0 ? undefined : process.argv[asOfIndex + 1];
if (asOfIndex >= 0 && !asOf) throw new Error("--as-of requires an ISO UTC timestamp");
const directory = process.env.CHARS_CACHE_PATH ?? ".cache";
const db = openDatabase();
try {
  const { source, calendar } = await auditedSeason(db.sqlite, season, directory);
  const snapshots = buildSnapshots(source, calendar, asOf);
  await publishSnapshots(`${directory}/snapshots`, season, snapshots);
  console.log(`Published ${snapshots.length} snapshots for ${season}; final: ${snapshots.some(snapshot => snapshot.kind === "selection_final")}`);
} finally { db.close(); }

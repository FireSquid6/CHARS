import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { openDatabase } from "./database";
import { readSeason, type SourceGameMetadata } from "./repository";
import { buildSnapshots, publishSnapshots, type CalendarPolicy } from "./snapshots";

const index = process.argv.indexOf("--season");
const season = Number(process.argv[index + 1]);
if (index < 0 || !Number.isSafeInteger(season) || season < 1) throw new Error("Usage: bun run snapshots:rebuild --season YEAR");
const directory = process.env.CHARS_CACHE_PATH ?? ".cache";
async function optional<T>(path: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback; throw error; }
}
const db = openDatabase();
try {
  const metadata = await optional<Record<string, SourceGameMetadata>>(join(directory, "source", `${season}-games.json`), {});
  const calendar = await optional<CalendarPolicy>(join(directory, "source", `${season}-calendar.json`), {});
  const snapshots = buildSnapshots(readSeason(db.sqlite, season, metadata), calendar);
  await publishSnapshots(join(directory, "snapshots"), season, snapshots);
  console.log(`Published ${snapshots.length} snapshots for ${season}; final: ${snapshots.some(snapshot => snapshot.kind === "selection_final")}`);
} finally { db.close(); }

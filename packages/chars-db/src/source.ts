import type { Database } from "bun:sqlite";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { readSeason, type PollTimingEvidence, type SeasonSource, type SourceGameMetadata } from "./repository";
import type { Audit } from "./ingest";
import type { CalendarPolicy } from "./snapshots";

export async function optionalJson<T>(path: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback; throw error; }
}

function utc(value: unknown): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}

function pollTimingSidecar(value: unknown): Record<string, PollTimingEvidence> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid reviewed poll timing sidecar");
  for (const evidence of Object.values(value)) {
    if (!evidence || typeof evidence !== "object" || Array.isArray(evidence)) throw new Error("Invalid reviewed poll timing entry");
    const entry = evidence as Record<string, unknown>;
    const interval = entry.interval as Record<string, unknown> | undefined;
    const exact = utc(entry.releasedAtUtc);
    const ranged = interval && !Array.isArray(interval) && utc(interval.earliestUtc) && utc(interval.latestUtc) &&
      Date.parse(interval.earliestUtc as string) <= Date.parse(interval.latestUtc as string);
    if (typeof entry.reviewedBy !== "string" || !entry.reviewedBy.trim() ||
      typeof entry.source !== "string" || !entry.source.trim() || !utc(entry.reviewedAtUtc) ||
      typeof entry.pollFingerprint !== "string" || !/^[a-f0-9]{64}$/.test(entry.pollFingerprint) ||
      (entry.releasedAtUtc === undefined) === (entry.interval === undefined) || !((entry.releasedAtUtc === undefined ? ranged : exact)) ||
      Date.parse(entry.reviewedAtUtc as string) < Date.parse(exact ? entry.releasedAtUtc as string : interval!.latestUtc as string)) {
      throw new Error("Reviewed poll timing needs one valid exact time or interval, source, reviewer, and matching fingerprint");
    }
  }
  return value as Record<string, PollTimingEvidence>;
}

/** Audit gaps and pending DB/filesystem handoffs must affect *both* sync and manual rebuild. */
export async function auditedSeason(db: Database, season: number, cache: string): Promise<{ source: SeasonSource; calendar: CalendarPolicy }> {
  const folder = join(cache, "source");
  const pending = await optionalJson<unknown>(join(folder, `${season}-pending.json`), null);
  if (pending !== null) throw new Error(`Pending season ${season} source handoff requires operator reconciliation`);
  const metadata = await optionalJson<Record<string, SourceGameMetadata>>(join(folder, `${season}-games.json`), {});
  const audit = await optionalJson<Audit | null>(join(folder, `${season}-audit.json`), null);
  if (audit && (audit.season !== season || JSON.stringify(audit.games) !== JSON.stringify(metadata)))
    throw new Error(`Season ${season} audit and game sidecar disagree; operator reconciliation required`);
  const calendar = await optionalJson<CalendarPolicy>(join(folder, `${season}-calendar.json`), {});
  const timing = pollTimingSidecar(await optionalJson<unknown>(join(folder, `${season}-poll-timing.json`), {}));
  calendar.pollTimingRevision = createHash("sha256").update(JSON.stringify(timing)).digest("hex");
  const source = readSeason(db, season, metadata);
  source.pollTiming = timing;
  if (audit) source.coverage.push(...audit.coverage);
  return { source, calendar };
}

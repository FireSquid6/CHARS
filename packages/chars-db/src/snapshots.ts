import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CALENDAR_POLICY_VERSION, MODEL_VERSION, POLICY_VERSION, computeColley, computeEligibility, computePlayoff } from "../../chars-algorithm/src/index";
import type { Game, SnapshotKind } from "../../chars-algorithm/src/index";
import type { PollTimingEvidence, SeasonSource } from "./repository";

const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export interface CalendarPolicy {
  /** Verified end of the final full regular-season weekend, strictly before the first CCG. */
  freezeUtc?: string;
  firstCcgUtc?: string;
  /** Operator assertion after schedule and game classification have been audited. */
  verified?: boolean;
  /** Source loader injects this hash to make a timing-review change trigger sync publication. */
  pollTimingRevision?: string;
}
export interface SnapshotArtifact {
  key: string;
  season: number;
  week: number | null;
  kind: SnapshotKind;
  gameCutoffUtc: string;
  pollCutoffUtc: string;
  pollReleaseId: string | null;
  pollPolicy: string;
  sourceHash: string;
  policyVersion: string;
  modelVersion: string;
  calendarPolicyVersion: string;
  coverage: string[];
  includedGameIds: string[];
  /** Weekly status is not a mathematical claim until the scenario solver proves it. */
  scenarioState: "pending";
  rankings: ReturnType<typeof computeColley>["ratings"];
  records: { teamId: string; record: ReturnType<typeof computeEligibility> extends Map<string, infer V> ? V : never }[];
  playoff: ReturnType<typeof computePlayoff>;
}

function date(value: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) throw new Error(`Invalid UTC timestamp: ${value}`);
  return parsed;
}

export function pollFingerprint(poll: SeasonSource["polls"][number]): string {
  return hash([poll.release.id, poll.release.season, poll.release.type,
    [...poll.entries].map(entry => [entry.teamId, entry.rank]).sort((a, b) =>
      String(a[0]) < String(b[0]) ? -1 : String(a[0]) > String(b[0]) ? 1 : 0)]);
}

function reviewedWindow(poll: SeasonSource["polls"][number], evidence: PollTimingEvidence | undefined):
  { earliest: number; latest: number } | null {
  if (!evidence || evidence.pollFingerprint !== pollFingerprint(poll) ||
    !evidence.reviewedBy?.trim() || !evidence.source?.trim() ||
    (evidence.releasedAtUtc === undefined) === (evidence.interval === undefined)) return null;
  const earliest = evidence.releasedAtUtc ? date(evidence.releasedAtUtc) : evidence.interval ? date(evidence.interval.earliestUtc) : NaN;
  const latest = evidence.releasedAtUtc ? earliest : evidence.interval ? date(evidence.interval.latestUtc) : NaN;
  return earliest <= latest && date(evidence.reviewedAtUtc) >= latest ? { earliest, latest } : null;
}

function currentSeasonAt(timestamp: number): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: process.env.SYNC_TIMEZONE || "America/Chicago", year: "numeric", month: "numeric" })
    .formatToParts(new Date(timestamp));
  const year = Number(parts.find(part => part.type === "year")?.value);
  return Number(parts.find(part => part.type === "month")?.value) >= 7 ? year : year - 1;
}

/** Retrospective convention: kickoff before the next regular-week kickoff, not asserted historical observation time. */
export function buildSnapshots(source: SeasonSource, calendar: CalendarPolicy = {}, asOfUtc = new Date().toISOString()): SnapshotArtifact[] {
  const asOf = date(asOfUtc);
  const current = source.season === currentSeasonAt(asOf);
  const freeze = calendar.freezeUtc === undefined ? Infinity : date(calendar.freezeUtc);
  const ccg = calendar.firstCcgUtc === undefined ? Infinity : date(calendar.firstCcgUtc);
  const finalPollType = source.season >= 2014 ? "cfp" : "ap";
  const finalCandidates = source.polls.filter(poll => {
    const window = reviewedWindow(poll, source.pollTiming?.[poll.release.id]);
    return poll.release.type === finalPollType && poll.entries.length > 0 && window !== null &&
      window.earliest >= freeze && window.latest < ccg;
  }).sort((a, b) => reviewedWindow(a, source.pollTiming?.[a.release.id])!.latest -
    reviewedWindow(b, source.pollTiming?.[b.release.id])!.latest || a.release.id.localeCompare(b.release.id));
  const hasFinalPoll = finalCandidates.length > 0;
  const validFinal = calendar.verified === true && Number.isFinite(freeze) && Number.isFinite(ccg) && freeze < ccg &&
    (!current || asOf >= ccg) && hasFinalPoll &&
    !source.coverage.length && source.games.every(game => game.classificationSource !== "legacy-regular-table-unverified" &&
      game.applicationGameType !== "unknown" && (game.applicationGameType !== "regular" || game.kickoffUtc === null ||
        date(game.kickoffUtc) >= freeze || game.completed || game.status === "cancelled"));
  const weeks = [...new Set(source.games.filter(game => game.applicationGameType === "regular" &&
    game.kickoffUtc !== null && date(game.kickoffUtc) < freeze).map(game => game.week).filter((week): week is number => week !== null))].sort((a, b) => a - b);
  const weekStarts = new Map(weeks.map(week => [week, Math.min(...source.games.filter(game => game.week === week && game.applicationGameType === "regular")
    .map(game => date(game.kickoffUtc!)))]));
  const scheduled = weeks.map((week, index) => ({ week, kind: "week_final" as SnapshotKind,
    cutoff: Math.min(weekStarts.get(weeks[index + 1]!) ?? (Number.isFinite(freeze) ? freeze :
      Math.max(...source.games.filter(game => game.week === week && game.applicationGameType === "regular")
        .map(game => date(game.kickoffUtc!))) + 7 * 24 * 60 * 60 * 1000), freeze) }));
  const descriptors: { week: number | null; kind: SnapshotKind; cutoff: number }[] =
    current ? scheduled.filter(snapshot => snapshot.cutoff <= asOf) : scheduled;
  if (current && !validFinal && asOf < freeze) {
    const pendingWeek = scheduled.find(snapshot => snapshot.cutoff > asOf);
    if (!scheduled.length || pendingWeek) {
      const started = pendingWeek?.week !== undefined && weekStarts.get(pendingWeek.week)! <= asOf;
      descriptors.push({ week: started ? pendingWeek!.week : null, kind: "partial", cutoff: asOf });
    }
  }
  if (validFinal) descriptors.push({ week: weeks.at(-1) ?? 0, kind: "selection_final", cutoff: freeze });
  // A missing explicit freeze never licenses a fabricated final; a cutoff after the last known week is provisional.
  return descriptors.map(({ week, kind, cutoff }) => {
    const included: Game[] = source.games.filter(game => game.applicationGameType === "regular" && game.completed &&
      game.week !== null && week !== null && (kind !== "partial" || game.week < week) && game.week <= week &&
      game.kickoffUtc !== null && date(game.kickoffUtc) < cutoff);
    const snapshotGames = { season: source.season, teams: source.teams, games: included };
    const preferred = source.season >= 2014 ? "cfp" : "ap";
    const available = source.polls.filter(poll => {
      if (kind === "selection_final") return finalCandidates.includes(poll);
      const reviewed = reviewedWindow(poll, source.pollTiming?.[poll.release.id]);
      const bound = reviewed?.latest ?? (poll.release.releasedAtUtc === null ? Infinity : date(poll.release.releasedAtUtc));
      return bound < cutoff && week !== null && poll.release.gameWeek !== null && poll.release.gameWeek <= week;
    });
    const primary = available.filter(poll => poll.release.type === preferred).at(-1);
    const fallback = kind !== "selection_final" && preferred === "cfp" ? available.filter(poll => poll.release.type === "ap").at(-1) : undefined;
    const chosen = kind === "selection_final" ? finalCandidates.at(-1) : primary ?? fallback;
    const coverage = source.coverage.filter(item => !item.startsWith("game ") ||
      source.games.some(game => item.startsWith(`game ${game.id}:`) && game.week !== null && week !== null &&
        (kind !== "partial" || game.week < week) && game.week <= week &&
        game.kickoffUtc !== null && date(game.kickoffUtc) < cutoff));
    if (!chosen) coverage.push(`${preferred.toUpperCase()} poll absent at declared cutoff`);
    else if (!reviewedWindow(chosen, source.pollTiming?.[chosen.release.id])) {
      coverage.push("Poll publication timing is a derived upper bound, not an independently verified release");
    }
    if (kind === "partial") coverage.push("Partial-week results omitted: historical completion observations unavailable");
    else if (chosen && kind !== "selection_final" && included.some(game => date(game.kickoffUtc!) >= date(chosen.release.releasedAtUtc!))) {
      coverage.push("No poll release following all included games; selection uses an earlier available poll");
    }
    const ratings = computeColley(snapshotGames);
    const records = [...computeEligibility(snapshotGames)].map(([teamId, record]) => ({ teamId, record }));
    const scopedGames = source.games.filter(game => game.week !== null && week !== null &&
      (kind !== "partial" || game.week < week) && game.week <= week &&
      game.kickoffUtc !== null && date(game.kickoffUtc) < cutoff);
    const sourceHash = hash({ teams: source.teams, games: scopedGames, poll: chosen,
      pollTiming: chosen && source.pollTiming?.[chosen.release.id], coverage, calendar });
    const inputHash = hash({ sourceHash, kind, week, cutoff, included: included.map(game => game.id).sort() });
    const key = `${source.season}-${kind}-${week}-${hash([inputHash, POLICY_VERSION, MODEL_VERSION, CALENDAR_POLICY_VERSION]).slice(0, 20)}`;
    const playoff = computePlayoff({ ...snapshotGames, ratings, records: records.map(row => ({ teamId: row.teamId, record: row.record.record })),
      pollEntries: chosen?.entries ?? [] }, { key, season: source.season, revision: 0, inputHash,
      policyVersion: POLICY_VERSION, modelVersion: MODEL_VERSION, calendarPolicyVersion: CALENDAR_POLICY_VERSION });
    return { key, season: source.season, week, kind, gameCutoffUtc: new Date(cutoff).toISOString(),
      pollCutoffUtc: new Date(kind === "selection_final" ? ccg : cutoff).toISOString(),
      pollReleaseId: chosen?.release.id ?? null, pollPolicy: chosen ? chosen.release.type === preferred ? preferred : "ap-provisional-fallback" : "absent",
      sourceHash, policyVersion: POLICY_VERSION, modelVersion: MODEL_VERSION, calendarPolicyVersion: CALENDAR_POLICY_VERSION,
      coverage, includedGameIds: included.map(game => game.id).sort(), scenarioState: "pending", rankings: ratings.ratings, records, playoff };
  });
}

/** Immutable content-addressed artifacts; pointer switches only after every file was successfully written. */
export async function publishSnapshots(directory: string, season: number, artifacts: readonly SnapshotArtifact[]): Promise<void> {
  const folder = join(directory, String(season));
  await mkdir(folder, { recursive: true });
  async function atomic(path: string, content: string): Promise<void> {
    const temporary = `${path}.${randomUUID()}.tmp`;
    try { await writeFile(temporary, content, { flag: "wx" }); await rename(temporary, path); }
    finally { await rm(temporary, { force: true }); }
  }
  for (const artifact of artifacts) {
    if (artifact.season !== season || !/^[a-zA-Z0-9_-]+$/.test(artifact.key)) throw new Error("Invalid artifact identity");
    await atomic(join(folder, `${artifact.key}.json`), JSON.stringify(artifact));
  }
  await atomic(join(folder, "current.json"), JSON.stringify({ season, keys: artifacts.map(artifact => artifact.key) }));
}

export async function readPublished(directory: string, season: number): Promise<SnapshotArtifact[]> {
  const folder = join(directory, String(season));
  const manifest = JSON.parse(await readFile(join(folder, "current.json"), "utf8")) as { keys: string[] };
  return Promise.all(manifest.keys.map(async key => JSON.parse(await readFile(join(folder, `${key}.json`), "utf8")) as SnapshotArtifact));
}

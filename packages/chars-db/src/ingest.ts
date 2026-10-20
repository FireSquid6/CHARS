import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Database } from "bun:sqlite";
import type { ProviderGame, ProviderPoll, ProviderWeek, createCfbdClient } from "./cfbd";
import type { SourceGameMetadata } from "./repository";

export type Input = Awaited<ReturnType<ReturnType<typeof createCfbdClient>["season"]>>;
export const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
export type Audit = { season: number; observedAtUtc: string; sources: { url: string; hash: string; raw: unknown }[]; games: Record<string, SourceGameMetadata>; postseason: { id: number; type: string; payloadHash: string; kickoffUtc: string }[]; coverage: string[]; counts: { inserted: number; updated: number; unchanged: number }; pollHash: string; membershipHash: string; calendarHash: string; material: boolean };

export type CalendarCandidate = { freezeUtc: string; firstCcgUtc: string; verified: false; provenance: "cfbd-calendar-and-explicit-ccg" };
/** A proposed cutoff, not proof that all historic schedules or poll releases are complete. */
export function deriveCalendarCandidate(games: readonly { game: ProviderGame; type: SourceGameMetadata["applicationGameType"] }[], weeks: readonly ProviderWeek[]): CalendarCandidate | null {
  if (games.some(row => row.type === "unknown")) return null;
  const ccgs = games.filter(row => row.type === "ccg").map(row => row.game.startDate).sort();
  if (!ccgs.length) return null;
  const firstCcgUtc = ccgs[0]!;
  const prior = weeks.filter(w => w.seasonType === "regular" && w.endUtc < firstCcgUtc).sort((a, b) => b.endUtc.localeCompare(a.endUtc));
  const freezeUtc = prior[0]?.endUtc;
  if (!freezeUtc || weeks.some(w => w.seasonType === "regular" && w.startUtc < firstCcgUtc && w.endUtc >= firstCcgUtc) ||
    games.some(row => row.type === "regular" && row.game.startDate >= freezeUtc && row.game.startDate < firstCcgUtc)) return null;
  return { freezeUtc, firstCcgUtc, verified: false, provenance: "cfbd-calendar-and-explicit-ccg" };
}

export function classify(game: ProviderGame, weeks: readonly ProviderWeek[], conferences: readonly string[]): SourceGameMetadata["applicationGameType"] {
  const notes = game.notes ?? "";
  const named = /\b([A-Za-z][A-Za-z0-9 .&-]{1,45})\s+championship(?:\s+game)?\b/i.exec(notes)?.[1]?.trim();
  const ccg = /\b(?:conference|conf\.)\s+championship\b/i.test(notes) || !!named && conferences.some(c => c.toLowerCase() === named.toLowerCase());
  const bowl = /\bbowl\b/i.test(notes);
  const playoff = game.playoff === true || /\b(?:college football playoff|cfp semifinal|national championship|playoff)\b/i.test(notes);
  if ([ccg, bowl, playoff].filter(Boolean).length > 1) return "unknown";
  if (playoff) return "playoff";
  if (ccg) return "ccg";
  if (bowl) return "bowl";
  if (game.seasonType === "regular" && !/\b(?:championship|postseason|title game)\b/i.test(notes) &&
    weeks.some(w => w.seasonType === "regular" && w.week === game.week && game.startDate >= w.startUtc && game.startDate <= w.endUtc)) return "regular";
  return "unknown";
}

function pollDate(poll: ProviderPoll, weeks: readonly ProviderWeek[]): string | null {
  // The provider rankings response does not supply publication timestamps. This is an
  // explicit derived *upper bound*, never represented as an actual release time.
  if (poll.seasonType !== "regular" || poll.week < 1) return null;
  const previous = weeks.find(w => w.week === poll.week - 1 && w.seasonType === "regular");
  const current = weeks.find(w => w.week === poll.week && w.seasonType === "regular");
  return previous && current && previous.endUtc < current.startUtc ? current.startUtc : null;
}

async function optional<T>(path: string, fallback: T): Promise<T> {
  try { return JSON.parse(await readFile(path, "utf8")) as T; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback; throw error; }
}
async function atomic(path: string, value: unknown): Promise<void> {
  const tmp = `${path}.${randomUUID()}.tmp`;
  try { await writeFile(tmp, JSON.stringify(value), { flag: "wx" }); await rename(tmp, path); }
  finally { await rm(tmp, { force: true }); }
}

/** Files are prepared before SQLite writes; a crash after DB commit may leave sidecars stale.
 * The pending journal permits recovery on the next run. This is NOT a cross-store transaction. */
export async function ingest(db: Database, season: number, input: Input, cache: string): Promise<Audit> {
  const folder = join(cache, "source"); await mkdir(folder, { recursive: true });
  const ids = new Set(input.teams.items.map(t => t.id));
  const fbs = new Set(input.fbs.items);
  const games = input.games.filter(g => fbs.has(g.homeId) || fbs.has(g.awayId));
  if (!fbs.size || !games.length || !input.calendar.items.length) throw new Error("Incomplete CFBD roster/schedule/calendar; previous data retained");
  if (games.some(g => !ids.has(g.homeId) || !ids.has(g.awayId))) throw new Error("Unknown opponent ID; refusing ambiguous alias resolution");
  const relevant = new Set(games.flatMap(g => [g.homeId, g.awayId]));
  if (input.teams.items.some(t => relevant.has(t.id) && t.membership === "other" && !/^(?:DIV2|DIV3)$/i.test(t.classification ?? ""))) throw new Error("Unverified opponent classification; previous data retained");
  if (input.teams.items.some(t => relevant.has(t.id) && !t.conference)) throw new Error("Missing opponent conference; existing schema requires a verified conference ID");
  if (games.some(g => g.status === "unknown")) throw new Error("Unknown game status; previous data retained");
  const names = new Map(input.teams.items.map(t => [t.id, t.school]));
  for (const g of games) if (names.get(g.homeId) !== g.homeTeam || names.get(g.awayId) !== g.awayTeam) throw new Error("Opponent name/ID mismatch; previous data retained");
  const conferences = input.teams.items.map(t => t.conference).filter((c): c is string => !!c);
  const types = games.map(g => ({ game: g, type: classify(g, input.calendar.items, conferences) }));
  const calendarCandidate = deriveCalendarCandidate(types, input.calendar.items);
  const coverage: string[] = [];
  if (types.some(t => t.type === "unknown")) coverage.push("Unknown game classification; review calendar and source notes");
  if (!input.rankings.items.length) coverage.push("No AP/CFP poll data");
  const old = await optional<Audit | null>(join(folder, `${season}-audit.json`), null);
  const existingMembers = db.query<{ team_id: string }, [number]>("SELECT team_id FROM seasons WHERE year=?").all(season);
  const missingMembers = existingMembers.filter(row => !ids.has(Number(row.team_id)));
  for (const row of missingMembers) {
    const referenced = db.query<{ game_id: number }, [number, string, string]>(
      "SELECT game_id FROM games WHERE year=? AND (home_team=? OR away_team=?) LIMIT 1").get(season, row.team_id, row.team_id);
    coverage.push(`Previously observed season team ${row.team_id} absent${referenced ? `; existing game ${referenced.game_id} still references it` : ""}; prior membership retained for review`);
  }
  if (old) {
    const observed = new Set(games.map(g => String(g.id)));
    for (const id of [...Object.keys(old.games), ...old.postseason.map(g => String(g.id))]) if (!observed.has(id)) coverage.push(`Previously observed game ${id} absent; not treated as cancellation`);
    const previousPolls = ((old.sources.find(s => s.url.includes("/rankings?"))?.raw ?? []) as unknown[]);
    const previousKeys = new Set(previousPolls.flatMap(value => {
      if (!value || typeof value !== "object") return [];
      const w = value as { week?: number; seasonType?: string; polls?: { poll?: string }[] };
      return (w.polls ?? []).filter(p => /^(?:AP|AP Top 25|CFP|College Football Playoff)$/i.test(p.poll ?? ""))
        .map(p => `${w.seasonType}:${w.week}:${/AP/i.test(p.poll ?? "") ? "ap" : "cfp"}`);
    }));
    const incomingPolls = new Set(input.rankings.items.map(p => `${p.seasonType}:${p.week}:${p.type}`));
    for (const key of previousKeys) if (!incomingPolls.has(key)) coverage.push(`Previously observed poll ${key} absent; previous release retained for review`);
  }
  const metadata: Record<string, SourceGameMetadata> = { ...old?.games };
  const counts = { inserted: 0, updated: 0, unchanged: 0 };
  const postseason: Audit["postseason"] = [];
  for (const { game, type } of types) {
    const payloadHash = digest(game.raw);
    if (type !== "regular") { delete metadata[String(game.id)]; postseason.push({ id: game.id, type, payloadHash, kickoffUtc: game.startDate }); continue; }
    metadata[String(game.id)] = { providerSeasonType: game.seasonType, applicationGameType: type, classificationSource: "cfbd+season-calendar:v1", status: game.status === "unknown" ? "scheduled" : game.status, completed: game.completed, payloadHash };
  }
  const sources = [input.fbs, input.teams, ...input.gameSources, input.rankings, input.calendar].map(s => ({ url: s.url, hash: digest(s.raw), raw: s.raw }));
  const audit: Audit = { season, observedAtUtc: input.calendar.observedAtUtc, sources, games: metadata, postseason,
    coverage, counts, pollHash: digest(input.rankings.raw), membershipHash: digest(input.teams.raw), calendarHash: digest(input.calendar.raw), material: false };
  const pending = join(folder, `${season}-pending.json`);
  // Recovery does not blindly replay sidecars from an unverified previous process.
  if (await optional<unknown>(pending, null) !== null) throw new Error(`Pending season ${season} publication requires operator review before another write`);
  await atomic(pending, { audit, phase: "prepared" });
  let committed = false;
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      const upsertTeam = db.query("INSERT INTO teams (team_id, team_name, abbreviation) VALUES (?,?,?) ON CONFLICT(team_id) DO UPDATE SET team_name=excluded.team_name, abbreviation=excluded.abbreviation");
      const upsertConference = db.query("INSERT INTO conferences (conference_id,name,abbreviation) VALUES (?,?,?) ON CONFLICT(conference_id) DO NOTHING");
      const upsertSeason = db.query("INSERT INTO seasons (team_id,year,conference_id,division,classification) VALUES (?,?,?,?,?) ON CONFLICT(team_id,year) DO UPDATE SET conference_id=excluded.conference_id, division=excluded.division, classification=excluded.classification");
      for (const t of input.teams.items) {
        if (!t.conference || t.membership === "other" && !/^(?:DIV2|DIV3)$/i.test(t.classification ?? "")) continue;
        const id = String(t.id), conference = t.conference;
        upsertTeam.run(id, t.school, t.abbreviation ?? t.school);
        upsertConference.run(conference, conference, conference);
        upsertSeason.run(id, season, conference, null, t.membership === "FBS" ? "FBS" : t.membership === "FCS" ? "FCS" : t.classification!.toUpperCase());
      }
      const existing = db.query<{ game_id: number; home_team: string; away_team: string; year: number; week: number; start_date: number; home_score: number | null; away_score: number | null; overtimes: number | null }, [number]>("SELECT * FROM games WHERE game_id=?");
      const saveGame = db.query("INSERT INTO games (game_id,home_team,away_team,year,week,start_date,home_score,away_score,overtimes) VALUES (?,?,?,?,?,?,?,?,?) ON CONFLICT(game_id) DO UPDATE SET home_team=excluded.home_team,away_team=excluded.away_team,week=excluded.week,start_date=excluded.start_date,home_score=excluded.home_score,away_score=excluded.away_score,overtimes=excluded.overtimes");
      const removePostseason = db.query("DELETE FROM games WHERE game_id=? AND year=?");
      for (const { game, type } of types) {
        if (type !== "regular") { if (existing.get(game.id)) { removePostseason.run(game.id, season); counts.updated++; } continue; }
        const before = existing.get(game.id);
        if (before && before.year !== season) throw new Error(`Game ${game.id} changed seasons; manual review required`);
        const values = [game.id, String(game.homeId), String(game.awayId), season, game.week, Date.parse(game.startDate), game.completed ? game.homePoints : null, game.completed ? game.awayPoints : null, null] as const;
        if (!before) counts.inserted++;
        else if (before.home_team !== values[1] || before.away_team !== values[2] || before.week !== values[4] || before.start_date !== values[5] || before.home_score !== values[6] || before.away_score !== values[7] || old?.games[String(game.id)]?.payloadHash !== metadata[String(game.id)]?.payloadHash) counts.updated++;
        else { counts.unchanged++; continue; }
        saveGame.run(...values);
      }
      const saveRelease = db.query("INSERT INTO poll_releases (release_id,poll_id,year,week,released_at) VALUES (?,?,?,?,?) ON CONFLICT(release_id) DO UPDATE SET released_at=excluded.released_at");
      const clearEntries = db.query("DELETE FROM poll_entries WHERE release_id=?");
      const saveEntry = db.query("INSERT INTO poll_entries (release_id,team_id,rank) VALUES (?,?,?)");
      for (const poll of input.rankings.items) {
        const releaseId = `cfbd:${season}:${poll.seasonType}:${poll.week}:${poll.type}`;
        const derived = pollDate(poll, input.calendar.items);
        if (!derived) { coverage.push(`Poll ${releaseId} has no verified release time (derived timing unavailable)`); continue; }
        if (poll.ranks.some(e => !input.teams.items.some(t => t.id === e.teamId && !!t.conference && (t.membership !== "other" || /^(?:DIV2|DIV3)$/i.test(t.classification ?? ""))))) { coverage.push(`Poll ${releaseId} has unresolved team IDs`); continue; }
        saveRelease.run(releaseId, poll.type, season, poll.week - 1, Date.parse(derived));
        clearEntries.run(releaseId);
        for (const entry of poll.ranks) saveEntry.run(releaseId, String(entry.teamId), entry.rank);
      }
      audit.material = !!counts.inserted || !!counts.updated || old?.pollHash !== audit.pollHash || old?.membershipHash !== audit.membershipHash || old?.calendarHash !== audit.calendarHash || digest(old?.postseason) !== digest(postseason);
      db.exec("COMMIT");
      committed = true;
    } catch (error) { db.exec("ROLLBACK"); throw error; }
    await atomic(pending, { audit, phase: "db-committed" });
    await atomic(join(folder, `${season}-games.json`), metadata);
    await atomic(join(folder, `${season}-audit.json`), audit);
    await atomic(join(folder, `${season}-calendar-candidate.json`), {
      candidate: audit.coverage.some(gap => gap !== "No AP/CFP poll data") ? null : calendarCandidate, observedAtUtc: audit.observedAtUtc,
      note: "Operator must verify the full schedule and poll window before setting YEAR-calendar.json verified=true"
    });
    await mkdir(join(folder, "revisions"), { recursive: true });
    await atomic(join(folder, "revisions", `${season}-${randomUUID()}.json`), audit);
    await rm(pending);
    return audit;
  } catch (error) {
    if (!committed) await rm(pending, { force: true });
    throw error;
  }
}

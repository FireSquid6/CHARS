import { openDatabase } from "chars-db";
import { buildSnapshot, calculateSelection, type Input, type Poll } from "chars-colley";
import type { Row } from "./output";

type Release = { id: string; type: "AP" | "CFP"; week: number; phase: string; released: string | Date | null; reference: string | Date | null };
type DatabaseGame = { id: string; home: string; away: string; week: number; start: string; homeScore: number | null; awayScore: number | null };
const iso = (value: string | Date) => new Date(value).toISOString();
const endOfDay = (value: string | Date) => new Date(`${iso(value).slice(0, 10)}T23:59:59.999Z`).toISOString();

export function cutoffDate(value: string): string {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value) || new Date(`${value}T00:00:00.000Z`).toISOString().slice(0, 10) !== value) {
    throw new Error("--terminal-cutoff must be a valid YYYY-MM-DD UTC date");
  }
  return `${value}T23:59:59.999Z`;
}

export function pickTerminal(releases: Release[], season: number, override?: string): { cutoff: string; release: Release | null } {
  if (override) return { cutoff: cutoffDate(override), release: null };
  const selection = releases.filter(p => p.type === "CFP" && p.phase === "selection" && p.reference).sort((a, b) => iso(a.reference!).localeCompare(iso(b.reference!)))[0];
  if (selection) {
    const prior = releases.filter(p => p.type === "CFP" && p.phase === "regular" && p.reference && iso(p.reference) < iso(selection.reference!)).sort((a, b) => iso(b.reference!).localeCompare(iso(a.reference!)))[0];
    if (prior) return { cutoff: endOfDay(prior.reference!), release: prior };
  }
  // Before CFP existed, the AP poll before the last regular poll precedes CCG weekend.
  const ap = releases.filter(p => p.type === "AP" && p.phase === "regular" && p.reference).sort((a, b) => iso(b.reference!).localeCompare(iso(a.reference!)));
  if (season >= 1992 && season < 2014 && ap.length >= 2) return { cutoff: endOfDay(ap[1].reference!), release: ap[1] };
  throw new Error("Terminal weekend cannot be inferred from poll metadata; supply --terminal-cutoff YYYY-MM-DD.");
}

export function chooseWeeklyPoll(releases: Release[], lastGame: number, nextGame: number, cutoff: string): Release | null {
  const candidates = releases.filter(p => p.phase === "regular" && p.reference && p.released &&
    Date.parse(endOfDay(p.reference)) >= lastGame && Date.parse(endOfDay(p.reference)) < nextGame &&
    Date.parse(endOfDay(p.reference)) <= Date.parse(cutoff));
  // Poll weeks are not game weeks: associate by reference date, then prefer CFP when available.
  return candidates.sort((a, b) => Date.parse(endOfDay(a.reference!)) - Date.parse(endOfDay(b.reference!)) ||
    (a.type === "CFP" ? -1 : 1) - (b.type === "CFP" ? -1 : 1))[0] ?? null;
}

export function chooseFinalPoll(releases: Release[], cutoff: string): Release | null {
  return releases.filter(p => p.phase === "regular" && p.reference && p.released && endOfDay(p.reference) <= cutoff)
    .sort((a, b) => endOfDay(b.reference!).localeCompare(endOfDay(a.reference!)) ||
      (a.type === "CFP" ? -1 : 1) - (b.type === "CFP" ? -1 : 1))[0] ?? null;
}

export async function getRankings(season: number, options: { week?: number; allWeeks?: boolean; terminalCutoff?: string } = {}): Promise<Row[]> {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required; configure your environment before starting CHARS.");
  const connection = openDatabase();
  try {
    const sql = connection.sql;
    const teams = await sql`
      SELECT t.team_id AS id, t.team_name AS name, (s.classification = 'FBS') AS fbs
      FROM seasons s JOIN teams t ON t.team_id = s.team_id WHERE s.year = ${season} ORDER BY t.team_id
    ` as { id: string; name: string; fbs: boolean }[];
    if (!teams.length) throw new Error(`Season ${season} was not found.`);
    const games = await sql`
      SELECT game_id::text AS id, home_team AS home, away_team AS away, week,
        start_date::text AS start, home_score AS "homeScore", away_score AS "awayScore"
      FROM games g WHERE g.year = ${season} AND EXISTS (
        SELECT 1 FROM seasons s WHERE s.year = g.year AND s.classification = 'FBS'
          AND s.team_id IN (g.home_team, g.away_team)
      ) ORDER BY start_date, game_id
    ` as DatabaseGame[];
    const releases = await sql`
      SELECT release_id AS id, poll_id AS type, week, poll_phase AS phase,
        poll_date AS released, week_reference_date AS reference
      FROM poll_releases WHERE year = ${season} AND poll_id IN ('AP', 'CFP')
      ORDER BY poll_date, release_id
    ` as Release[];
    const entries = await sql`
      SELECT e.release_id AS id, e.team_id AS "teamId", e.rank
      FROM poll_entries e JOIN poll_releases p ON p.release_id = e.release_id
      WHERE p.year = ${season} AND p.poll_id IN ('AP', 'CFP') ORDER BY e.release_id, e.rank, e.team_id
    ` as { id: string; teamId: string; rank: number }[];
    const byRelease = new Map(releases.map(p => [p.id, [] as { teamId: string; rank: number }[]]));
    for (const e of entries) byRelease.get(e.id)?.push({ teamId: e.teamId, rank: e.rank });
    const polls: Poll[] = releases.filter(p => p.released).map(p => ({ id: p.id, type: p.type, week: p.week, year: season, releasedAt: iso(p.released!), entries: byRelease.get(p.id)! }));
    const terminal = pickTerminal(releases, season, options.terminalCutoff);
    const scheduled = games.map(g => Number(g.start)).filter(Number.isSafeInteger);
    if (scheduled.length !== games.length) throw new Error("Invalid game start timestamp in archive");
    const availableWeeks = [...new Set(games.filter(g => Number(g.start) <= Date.parse(terminal.cutoff)).map(g => g.week))].sort((a, b) => a - b);
    const source: Input = {
      year: season, teams, polls, terminalCutoff: terminal.cutoff,
      membershipComplete: true, scheduleComplete: true, pollsComplete: true,
      games: games.map(g => ({ id: g.id, year: season, week: g.week, home: g.home, away: g.away, kind: "regular", scheduledAt: new Date(Number(g.start)).toISOString(),
        status: g.homeScore === null && g.awayScore === null ? "scheduled" : "completed",
        homeScore: g.homeScore, awayScore: g.awayScore,
        completedAt: g.homeScore !== null && g.awayScore !== null ? new Date(Number(g.start)).toISOString() : undefined })),
    };
    const weeks = options.allWeeks ? availableWeeks : options.week === undefined ? [null] : [options.week];
    const rows: Row[] = [];
    for (const week of weeks) {
      if (week !== null && !availableWeeks.includes(week)) throw new Error(`Game week ${week} does not occur before the terminal cutoff in ${season}.`);
      const last = week === null ? Date.parse(terminal.cutoff) : Math.max(...games.filter(g => g.week === week && Number(g.start) <= Date.parse(terminal.cutoff)).map(g => Number(g.start)));
      const next = week === null ? Infinity : Math.min(Infinity, ...games.filter(g => g.week > week).map(g => Number(g.start)));
      const associated = week === null ? terminal.release ?? chooseFinalPoll(releases, terminal.cutoff) : chooseWeeklyPoll(releases, last, next, terminal.cutoff);
      if (!associated?.released || !associated.reference) throw new Error(`No associated AP/CFP poll for ${season}${week === null ? " terminal snapshot" : ` game week ${week}`}; data is incomplete.`);
      const cutoff = week === null ? terminal.cutoff : endOfDay(associated.reference);
      const snapshot = buildSnapshot(source, cutoff, associated.id);
      const result = calculateSelection(snapshot);
      const record = new Map(result.records.map(r => [r.teamId, r]));
      const field = new Map(result.final.entries.map(e => [e.teamId, e]));
      const seed = new Map(result.seeds.map(e => [e.teamId, e.adjustedRank]));
      const names = new Map(teams.map(t => [t.id, t.name]));
      for (const rating of result.ratings) {
        const r = record.get(rating.teamId)!;
        rows.push({ year: season, week: week ?? "final", cutoff: snapshot.cutoff.slice(0, 10), poll: associated.type, pollRelease: associated.id,
          pollFallback: snapshot.pollFallback, rawRank: rating.rawRank, teamId: rating.teamId, team: names.get(rating.teamId),
          record: `${r.wins}-${r.losses}${r.ties ? `-${r.ties}` : ""}`, rating: rating.rating,
          eligible: r.eligible, playoffStatus: !r.eligible ? "ineligible" : field.get(rating.teamId)?.category ?? "outside",
          adjustedRank: seed.get(rating.teamId) ?? null, initialRoute: field.get(rating.teamId)?.route ?? "outside" });
      }
    }
    return rows;
  } finally {
    await connection.close();
  }
}

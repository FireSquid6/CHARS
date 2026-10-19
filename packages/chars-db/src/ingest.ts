/** Server-only, atomic observation and normalized season ingestion. No network IO inside the transaction. */
import { createHash, randomUUID } from "node:crypto";
import type { Database } from "bun:sqlite";
import { createClient, createTeamResolver, filterFbsGames, type CalendarWeek, type Game, type Source } from "chars-cfbd";
import { createRepository, transaction } from "./index";

type Client = ReturnType<typeof createClient>;
export type SeasonInput = {
  games: Awaited<ReturnType<Client["games"]>>;
  teams: Awaited<ReturnType<Client["teams"]>>;
  rankings: Awaited<ReturnType<Client["rankings"]>>;
  calendar: Awaited<ReturnType<Client["calendar"]>>;
};
export type IngestionReport = { year: number; inserted: number; revised: number; unchanged: number;
  pollReleases: number; calendarWeeks: number; coverage: Record<string, boolean>; selectionFreezeUtc: string | null };

export async function fetchSeason(client: Client, year: number): Promise<SeasonInput> {
  // Fetch and validate everything before opening the write transaction.
  const teams = await client.teams(year);
  const games = await client.games(year);
  const rankings = await client.rankings(year);
  const calendar = await client.calendar(year);
  return { teams, games, rankings, calendar };
}

function hash(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function membership(value: string): "fbs" | "fcs" | "other" {
  return value === "fbs" || value === "fcs" ? value : "other";
}
type Classification = { type: "regular" | "ccg" | "bowl" | "playoff" | "unknown"; evidence: Record<string, unknown> };
export function classifyGame(game: Game, calendar: readonly CalendarWeek[]): Classification {
  const evidence: Record<string, unknown> = { providerSeasonType: game.providerSeasonType, notes: game.notes,
    playoff: game.playoff, calendarWeek: game.week };
  const notes = game.notes ?? "";
  const ccg = /\b(?:conference|conf\.)\s+championship\b/i.test(notes);
  const bowl = /\bbowl\b/i.test(notes);
  const playoff = game.playoff === true || /\b(?:college football playoff|cfp semifinal|national championship|playoff)\b/i.test(notes);
  if ([ccg, bowl, playoff].filter(Boolean).length > 1) return { type: "unknown", evidence: { ...evidence, reason: "conflicting_postseason_signals" } };
  if (playoff) return { type: "playoff", evidence: { ...evidence, rule: "explicit_playoff_marker" } };
  if (ccg) return { type: "ccg", evidence: { ...evidence, rule: "explicit_conference_championship_notes" } };
  if (bowl) return { type: "bowl", evidence: { ...evidence, rule: "explicit_bowl_notes" } };
  const week = calendar.find(w => w.seasonType === "regular" && w.week === game.week &&
    game.kickoffUtc >= w.startUtc && game.kickoffUtc <= w.endUtc);
  if (game.providerSeasonType === "regular" && week && !/\b(?:championship|postseason|title game)\b/i.test(notes) && game.playoff !== true) {
    return { type: "regular", evidence: { ...evidence, rule: "provider_regular_and_matching_calendar_window", startUtc: week.startUtc, endUtc: week.endUtc } };
  }
  return { type: "unknown", evidence: { ...evidence, reason: "insufficient_or_ambiguous_game_classification" } };
}

export function currentFootballSeason(now = new Date()): number {
  if (Number.isNaN(now.getTime())) throw new Error("Invalid current date");
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Chicago", year: "numeric", month: "numeric" }).formatToParts(now);
  const year = Number(parts.find(p => p.type === "year")?.value), month = Number(parts.find(p => p.type === "month")?.value);
  // January through June belong to the preceding fall; July starts the next season's preseason.
  return month < 7 ? year - 1 : year;
}

export function ingestSeason(db: Database, year: number, input: SeasonInput): IngestionReport {
  if (!Number.isSafeInteger(year) || year < 1998) throw new Error("Backfill supports seasons from 1998");
  const fbs = new Set(input.teams.items.filter(t => t.membership === "fbs").map(t => t.id));
  if (!fbs.size) throw new Error(`Season ${year} has no FBS roster; refusing to overwrite existing data`);
  const games = filterFbsGames(input.games.items, fbs);
  const resolver = createTeamResolver(input.teams.items, games);
  const classifications = games.map(game => ({ game, classification: classifyGame(game, input.calendar.items) }));
  const ccgDates = classifications.filter(g => g.classification.type === "ccg").map(g => g.game.kickoffUtc).sort();
  const ccgStart = ccgDates[0] ?? null;
  const weeks = input.calendar.items.filter(w => w.seasonType === "regular" && (!ccgStart || w.endUtc < ccgStart)).sort((a, b) => a.endUtc.localeCompare(b.endUtc));
  const freeze = ccgStart && weeks.length ? weeks.at(-1)!.endUtc : null;
  const coverage = {
    fbsRoster: true, schedule: games.length > 0, calendar: weeks.length > 0,
    gameClassification: games.every(g => classifyGame(g, input.calendar.items).type !== "unknown"),
    gameStatusKnown: games.every(g => g.status !== "unknown"),
    gameMembership: games.every(g => { const sides = resolver.game(g); return sides.home.membership !== "unknown" && sides.away.membership !== "unknown"; }),
    polls: input.rankings.items.some(w => w.polls.some(p => /^(?:AP Top 25|AP|CFP|College Football Playoff)$/i.test(p.name))),
    pollReleaseTiming: input.rankings.items.every(w => w.releasedAtUtc !== null),
    selectionFreeze: freeze !== null
  };
  const report: IngestionReport = { year, inserted: 0, revised: 0, unchanged: 0, pollReleases: 0,
    calendarWeeks: input.calendar.items.length, coverage, selectionFreezeUtc: freeze };
  return transaction(db, () => {
    const repo = createRepository(db);
    repo.saveSeason({ year, state: "incomplete", selectionFreezeUtc: freeze,
      calendarPolicyVersion: "pre-ccg-last-full-regular-week-v1", coverage: JSON.stringify(coverage) });
    function observe<T>(category: string, source: Source<T>): string {
      const id = randomUUID();
      db.query("INSERT INTO ingestion_payloads (id, source, source_url, season, hash, observed_at_utc, raw_json) VALUES (?, ?, ?, ?, ?, ?, ?)")
        .run(id, `cfbd:${category}`, source.sourceUrl, year, hash(source.raw), source.observedAtUtc, JSON.stringify(source.raw));
      return id;
    }
    const fbsSourceId = observe("teams/fbs", input.teams.fbsSource);
    observe("teams", input.teams);
    const gameSources = input.games.sources.map(s => ({ id: observe("games", s), source: s }));
    const rankingsId = observe("rankings", input.rankings), calendarId = observe("calendar", input.calendar);
    void fbsSourceId;
    for (const team of input.teams.items) {
      const identity = resolver.byProviderId(team.id);
      repo.saveTeam({ id: identity.id, providerId: team.id, name: team.school, abbreviation: team.abbreviation });
      repo.saveTeamSeason({ season: year, teamId: identity.id, membership: membership(team.membership), conference: team.conference });
    }
    // FCS opponents omitted from the season roster still have stable numeric provider identities.
    for (const game of games) for (const side of Object.values(resolver.game(game))) {
      if (!repo.team(side.id)) repo.saveTeam({ id: side.id, providerId: side.providerId, name: side.name, abbreviation: null });
      repo.saveTeamSeason({ season: year, teamId: side.id, membership: membership(side.membership), conference: side.conference });
    }
    const aliases = new Map<string, string | null>();
    for (const team of input.teams.items) for (const alias of [team.school, team.abbreviation, ...team.alternateNames]) {
      if (!alias) continue;
      const key = alias.trim().toLowerCase();
      const id = `cfbd:${team.id}`, previous = aliases.get(key);
      aliases.set(key, previous === undefined ? id : previous === id ? id : null);
    }
    for (const [alias, id] of aliases) if (id) db.query("INSERT INTO team_aliases (source, alias, team_id) VALUES (?, ?, ?) ON CONFLICT(source, alias) DO UPDATE SET team_id=excluded.team_id")
      .run(`cfbd:${year}`, alias, id);
    for (const week of input.calendar.items) {
      db.query(`INSERT INTO season_calendar_weeks (season, season_type, week, start_utc, end_utc, payload_id, source_hash)
        VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(season, season_type, week) DO UPDATE SET
        start_utc=excluded.start_utc, end_utc=excluded.end_utc, payload_id=excluded.payload_id, source_hash=excluded.source_hash`)
        .run(year, week.seasonType, week.week, week.startUtc, week.endUtc, calendarId, hash(week.raw));
    }
    for (const { game, classification } of classifications) {
      const id = `cfbd:${game.id}`, payloadHash = hash(game.raw);
      const prior = db.query<{ result_revision: number; payload_hash: string; normalized_json: string; season: number }, [string]>(
        `SELECT g.result_revision, g.payload_hash, r.normalized_json, g.season FROM games g
         JOIN game_revisions r ON r.game_id=g.id AND r.revision=g.result_revision WHERE g.id=?`).get(id);
      if (prior && prior.season !== year) throw new Error(`Game ${id} moved between seasons; manual reconciliation required`);
      const normalized = { season: year, week: game.week, homeId: `cfbd:${game.homeId}`, awayId: `cfbd:${game.awayId}`,
        kickoffUtc: game.kickoffUtc, homeScore: game.completed ? game.homePoints : null,
        awayScore: game.completed ? game.awayPoints : null, status: game.status === "unknown" ? "scheduled" : game.status,
        completed: game.completed, providerStatusEvidence: game.status, providerSeasonType: game.providerSeasonType, applicationGameType: classification.type,
        classificationProvenance: classification.evidence };
      const json = JSON.stringify(normalized);
      if (prior?.payload_hash === payloadHash && prior.normalized_json === json) {
        report.unchanged++;
        db.query("UPDATE games SET last_seen_utc=? WHERE id=?").run(input.games.sources[0].observedAtUtc, id);
        continue;
      }
      const source = gameSources.find(s => (s.source.raw as unknown[]).some(raw =>
        raw && typeof raw === "object" && "id" in raw && String(raw.id) === game.id));
      if (!source) throw new Error(`No source observation for game ${id}`);
      const observed = source.source.observedAtUtc;
      db.query(`INSERT INTO games (id, provider_game_id, season, week, home_team_id, away_team_id, kickoff_utc,
        home_score, away_score, status, completed, provider_season_type, application_game_type, classification_source,
        classification_provenance_json, provider_status_evidence, first_seen_utc, last_seen_utc, payload_hash, result_revision)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET week=excluded.week, home_team_id=excluded.home_team_id,
        away_team_id=excluded.away_team_id, kickoff_utc=excluded.kickoff_utc, home_score=excluded.home_score,
        away_score=excluded.away_score, status=excluded.status, completed=excluded.completed,
        provider_season_type=excluded.provider_season_type, application_game_type=excluded.application_game_type,
        classification_source=excluded.classification_source, classification_provenance_json=excluded.classification_provenance_json,
        provider_status_evidence=excluded.provider_status_evidence,
        last_seen_utc=excluded.last_seen_utc, payload_hash=excluded.payload_hash, result_revision=excluded.result_revision`)
        .run(id, game.id, year, game.week, normalized.homeId, normalized.awayId, game.kickoffUtc,
          normalized.homeScore, normalized.awayScore, normalized.status, Number(game.completed), game.providerSeasonType,
          classification.type, "cfbd+calendar:v1", JSON.stringify(classification.evidence), game.status, observed, observed, payloadHash, (prior?.result_revision ?? 0) + 1);
      db.query(`INSERT INTO game_revisions (game_id, revision, payload_id, payload_hash, observed_at_utc, previous_normalized_json, normalized_json)
        VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, (prior?.result_revision ?? 0) + 1, source.id, payloadHash, observed,
          prior?.normalized_json ?? null, json);
      if (prior) report.revised++; else report.inserted++;
    }
    for (const week of input.rankings.items) for (const poll of week.polls) {
      const pollType = /^(?:AP Top 25|AP)$/i.test(poll.name) ? "ap" :
        /^(?:CFP|College Football Playoff)$/i.test(poll.name) ? "cfp" : null;
      if (!pollType) continue;
      const sourceHash = hash(poll.raw);
      const id = `cfbd:${year}:${week.seasonType}:${week.week}:${pollType}:${sourceHash}`;
      if (db.query("SELECT 1 FROM poll_releases WHERE id=?").get(id)) continue;
      db.query(`INSERT INTO poll_releases (id, season, poll_type, game_week, released_at_utc, effective_at_utc,
        source_hash, payload_id, timing_provenance) VALUES (?, ?, ?, ?, NULL, NULL, ?, ?, 'unknown_provider_has_no_release_time')`)
        .run(id, year, pollType, week.week, sourceHash, rankingsId);
      for (const entry of poll.entries) {
        const identity = resolver.byProviderId(entry.teamId);
        db.query("INSERT INTO poll_entries (release_id, team_id, rank, points) VALUES (?, ?, ?, ?)")
          .run(id, identity.id, entry.rank, entry.points);
      }
      report.pollReleases++;
    }
    return report;
  });
}

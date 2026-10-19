import type { Database } from "bun:sqlite";

/** Historical reconstruction uses kickoff + full calendar week, never a claimed historical API observation. */
export function gamesAtCutoff(db: Database, season: number, cutoffUtc: string) {
  return db.query<{ id: string; result_revision: number; kickoff_utc: string }, [number, string, string]>(`
    SELECT g.id, g.result_revision, g.kickoff_utc FROM games g
    JOIN season_calendar_weeks w ON w.season=g.season AND w.season_type='regular' AND w.week=g.week
    WHERE g.season=? AND g.completed=1 AND g.application_game_type='regular'
      AND g.kickoff_utc <= ? AND w.end_utc <= ?
    ORDER BY g.kickoff_utc, g.id`).all(season, cutoffUtc, cutoffUtc);
}

/** Null release times are not evidence of publication by the cutoff; no `latest` hindsight fallback. */
export function pollsAtCutoff(db: Database, season: number, cutoffUtc: string) {
  return db.query<{ id: string; poll_type: string; game_week: number }, [number, string, string]>(`
    SELECT id, poll_type, game_week FROM poll_releases
    WHERE season=? AND released_at_utc IS NOT NULL AND released_at_utc <= ?
      AND effective_at_utc IS NOT NULL AND effective_at_utc <= ?
    ORDER BY effective_at_utc DESC, id`).all(season, cutoffUtc, cutoffUtc);
}

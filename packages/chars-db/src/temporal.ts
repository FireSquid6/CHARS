import type { Database } from "bun:sqlite";

/** Missing completion timestamps imply reconstructed week-final inclusion, not historical point-in-time knowledge. */
export function gamesAtCutoff(db: Database, season: number, cutoffUtc: string) {
  return db.query<{ id: string; result_revision: number; kickoff_utc: string; inclusion_convention: string }, [number, string, string, string]>(`
    SELECT g.id, g.result_revision, g.kickoff_utc,
      CASE WHEN g.completed_at_utc IS NULL THEN 'reconstructed_week_final' ELSE 'provider_completion_timestamp' END AS inclusion_convention
    FROM games g
    JOIN season_calendar_weeks w ON w.season=g.season AND w.season_type='regular' AND w.week=g.week
    WHERE g.season=? AND g.completed=1 AND g.application_game_type='regular'
      AND g.kickoff_utc <= ? AND w.end_utc <= ?
      AND (g.completed_at_utc IS NULL OR (g.completed_at_utc <= w.end_utc AND g.completed_at_utc <= ?))
    ORDER BY g.kickoff_utc, g.id`).all(season, cutoffUtc, cutoffUtc, cutoffUtc);
}

/** Derived effective dates are weekly conventions, not actual publication dates. */
export function pollsAtCutoff(db: Database, season: number, cutoffUtc: string) {
  return db.query<{ id: string; poll_type: string; game_week: number; timing_provenance: string }, [number, string, string]>(`
    SELECT id, poll_type, game_week, timing_provenance FROM poll_releases
    WHERE season=? AND is_current=1 AND effective_at_utc IS NOT NULL AND effective_at_utc <= ?
      AND (timing_provenance='derived_convention' OR released_at_utc <= ?)
    ORDER BY effective_at_utc DESC, id`).all(season, cutoffUtc, cutoffUtc);
}

import type { Database } from "bun:sqlite";

export class SnapshotOutputMigrationError extends Error {
  constructor() {
    super("Database migrations required for snapshot JSON (through 012). Stop site and workers, back up SQLite, then run bun run db:migrate.");
  }
}

/** Check before preparing any reader queries: older databases may lack publication or audit tables. */
export function assertSnapshotOutputSchema(db: Database): void {
  const required = ["snapshots", "snapshot_publications", "snapshot_games", "game_revisions",
    "snapshot_rankings", "selection_events", "bracket_slots", "snapshot_h2h_audit", "snapshot_poll_audit",
    "poll_releases", "teams", "ingestion_payloads"];
  const present = new Set(db.query<{ name: string }, []>(
    "SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name));
  if (required.some(name => !present.has(name))) throw new SnapshotOutputMigrationError();
}

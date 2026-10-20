import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { assertSnapshotOutputSchema, SnapshotOutputMigrationError } from "../lib/snapshot-output-schema";

test("pre-012 databases produce an explicit migration requirement, not a missing-table exception", () => {
  const db = new Database(":memory:");
  try {
    const required = ["snapshots", "snapshot_publications", "snapshot_games", "game_revisions",
      "snapshot_rankings", "selection_events", "bracket_slots", "poll_releases", "teams", "ingestion_payloads"];
    for (const name of required) db.exec(`CREATE TABLE ${name} (id TEXT)`);
    expect(() => assertSnapshotOutputSchema(db)).toThrow(SnapshotOutputMigrationError);
    expect(() => assertSnapshotOutputSchema(db)).toThrow("bun run db:migrate");
    db.exec("CREATE TABLE snapshot_h2h_audit (id TEXT)");
    expect(() => assertSnapshotOutputSchema(db)).toThrow(SnapshotOutputMigrationError);
    db.exec("CREATE TABLE snapshot_poll_audit (id TEXT)");
    expect(() => assertSnapshotOutputSchema(db)).not.toThrow();
  } finally { db.close(); }
});

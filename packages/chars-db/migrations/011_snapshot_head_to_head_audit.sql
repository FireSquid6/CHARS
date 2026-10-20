CREATE TABLE snapshot_h2h_audit (
  snapshot_key TEXT NOT NULL,
  snapshot_revision INTEGER NOT NULL,
  graph_json TEXT NOT NULL,
  unapplied_claims_json TEXT NOT NULL,
  PRIMARY KEY (snapshot_key, snapshot_revision),
  FOREIGN KEY (snapshot_key, snapshot_revision) REFERENCES snapshots(snapshot_key, revision)
);

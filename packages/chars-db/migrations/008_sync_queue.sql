CREATE TABLE scenario_work_queue (
  snapshot_key TEXT NOT NULL,
  snapshot_revision INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','running','done','failure')),
  attempts INTEGER NOT NULL DEFAULT 0,
  owner TEXT,
  expires_at_utc TEXT,
  updated_at_utc TEXT NOT NULL,
  error TEXT,
  PRIMARY KEY (snapshot_key, snapshot_revision),
  FOREIGN KEY (snapshot_key, snapshot_revision) REFERENCES snapshots(snapshot_key, revision)
);
CREATE INDEX scenario_work_pending ON scenario_work_queue(state, expires_at_utc);

-- New publications only: historical poll rows cannot be reconstructed from mutable releases.
CREATE TABLE snapshot_poll_audit (
  snapshot_key TEXT NOT NULL,
  snapshot_revision INTEGER NOT NULL,
  metadata_json TEXT,
  entries_json TEXT NOT NULL,
  PRIMARY KEY (snapshot_key, snapshot_revision),
  FOREIGN KEY (snapshot_key, snapshot_revision) REFERENCES snapshots(snapshot_key, revision),
  CHECK (json_valid(entries_json)),
  CHECK (metadata_json IS NULL OR json_valid(metadata_json))
);

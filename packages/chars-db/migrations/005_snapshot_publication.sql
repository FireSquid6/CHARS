CREATE TABLE snapshot_publications (
  snapshot_key TEXT PRIMARY KEY,
  revision INTEGER NOT NULL,
  published_at_utc TEXT NOT NULL,
  FOREIGN KEY (snapshot_key, revision) REFERENCES snapshots(snapshot_key, revision)
);
INSERT INTO snapshot_publications (snapshot_key, revision, published_at_utc)
  SELECT s.snapshot_key, s.revision, s.published_at_utc FROM snapshots s
  WHERE s.published_at_utc IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM snapshots newer WHERE newer.snapshot_key=s.snapshot_key
      AND newer.published_at_utc IS NOT NULL AND newer.revision>s.revision
  );
CREATE INDEX snapshot_publications_revision ON snapshot_publications(snapshot_key, revision);

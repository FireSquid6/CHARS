CREATE TABLE season_calendar_weeks (
  season INTEGER NOT NULL REFERENCES seasons(year),
  season_type TEXT NOT NULL,
  week INTEGER NOT NULL CHECK (week >= 0),
  start_utc TEXT NOT NULL,
  end_utc TEXT NOT NULL,
  payload_id TEXT REFERENCES ingestion_payloads(id),
  source_hash TEXT NOT NULL,
  PRIMARY KEY (season, season_type, week),
  CHECK (start_utc <= end_utc)
);
CREATE INDEX calendar_season_dates ON season_calendar_weeks(season, start_utc, end_utc);
ALTER TABLE poll_releases ADD COLUMN timing_provenance TEXT NOT NULL DEFAULT 'unknown';
ALTER TABLE games ADD COLUMN classification_provenance_json TEXT NOT NULL DEFAULT '{}';
ALTER TABLE games ADD COLUMN provider_status_evidence TEXT NOT NULL DEFAULT 'legacy_unknown';
CREATE TABLE poll_entries_replacement (
  release_id TEXT NOT NULL REFERENCES poll_releases(id),
  team_id TEXT NOT NULL REFERENCES teams(id),
  rank INTEGER CHECK (rank >= 1),
  points REAL CHECK (points >= 0),
  PRIMARY KEY (release_id, team_id)
);
INSERT INTO poll_entries_replacement SELECT * FROM poll_entries;
DROP TABLE poll_entries;
ALTER TABLE poll_entries_replacement RENAME TO poll_entries;
CREATE INDEX poll_entries_rank ON poll_entries(release_id, rank);

ALTER TABLE poll_releases ADD COLUMN is_current INTEGER NOT NULL DEFAULT 1 CHECK (is_current IN (0,1));
ALTER TABLE poll_releases ADD COLUMN provider_season_type TEXT NOT NULL DEFAULT 'unknown';
UPDATE poll_releases SET provider_season_type = 'regular'
  WHERE id LIKE 'cfbd:' || season || ':regular:' || game_week || ':%';
UPDATE poll_releases SET provider_season_type = 'postseason'
  WHERE id LIKE 'cfbd:' || season || ':postseason:' || game_week || ':%';
ALTER TABLE games ADD COLUMN completed_at_utc TEXT;
UPDATE poll_releases SET is_current=0 WHERE game_week IS NOT NULL AND EXISTS (
  SELECT 1 FROM poll_releases newer
  LEFT JOIN ingestion_payloads newer_payload ON newer_payload.id=newer.payload_id
  LEFT JOIN ingestion_payloads old_payload ON old_payload.id=poll_releases.payload_id
  WHERE newer.season=poll_releases.season AND newer.poll_type=poll_releases.poll_type
    AND newer.provider_season_type=poll_releases.provider_season_type
    AND newer.game_week=poll_releases.game_week AND newer.id<>poll_releases.id
    AND (COALESCE(newer_payload.observed_at_utc, '') > COALESCE(old_payload.observed_at_utc, '')
      OR (COALESCE(newer_payload.observed_at_utc, '') = COALESCE(old_payload.observed_at_utc, '')
        AND newer.id > poll_releases.id))
);
CREATE UNIQUE INDEX poll_current_week ON poll_releases(season, poll_type, provider_season_type, game_week)
  WHERE is_current=1 AND game_week IS NOT NULL;
CREATE TABLE calendar_revisions (
  season INTEGER NOT NULL REFERENCES seasons(year), season_type TEXT NOT NULL,
  week INTEGER NOT NULL, revision INTEGER NOT NULL CHECK (revision >= 1),
  start_utc TEXT NOT NULL, end_utc TEXT NOT NULL,
  source_hash TEXT NOT NULL, payload_id TEXT REFERENCES ingestion_payloads(id),
  observed_at_utc TEXT NOT NULL,
  PRIMARY KEY (season, season_type, week, revision)
);
CREATE TABLE season_ingestion_gaps (
  id TEXT PRIMARY KEY, season INTEGER NOT NULL REFERENCES seasons(year),
  observed_at_utc TEXT NOT NULL, coverage_json TEXT NOT NULL,
  selection_freeze_utc TEXT,
  CHECK (length(coverage_json) > 0)
);
CREATE INDEX season_ingestion_gaps_latest ON season_ingestion_gaps(season, observed_at_utc);
CREATE TABLE snapshot_input_invalidations (
  snapshot_key TEXT NOT NULL, snapshot_revision INTEGER NOT NULL,
  reason TEXT NOT NULL, input_id TEXT NOT NULL, observed_at_utc TEXT NOT NULL,
  PRIMARY KEY (snapshot_key, snapshot_revision, reason, input_id),
  FOREIGN KEY (snapshot_key, snapshot_revision) REFERENCES snapshots(snapshot_key, revision)
);
INSERT INTO calendar_revisions (season, season_type, week, revision, start_utc, end_utc, source_hash, payload_id, observed_at_utc)
  SELECT w.season, w.season_type, w.week, 1, w.start_utc, w.end_utc, w.source_hash, w.payload_id,
    COALESCE(p.observed_at_utc, 'unknown_legacy')
  FROM season_calendar_weeks w LEFT JOIN ingestion_payloads p ON p.id=w.payload_id;

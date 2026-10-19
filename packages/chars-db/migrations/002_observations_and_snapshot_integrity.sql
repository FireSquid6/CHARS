-- The migration runner disables connection-local FK enforcement before BEGIN
-- IMMEDIATE, checks all links before commit, then restores enforcement.
CREATE TABLE ingestion_payloads_replacement (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  source_url TEXT NOT NULL,
  season INTEGER REFERENCES seasons(year),
  hash TEXT NOT NULL,
  observed_at_utc TEXT NOT NULL,
  raw_json TEXT NOT NULL
);
INSERT INTO ingestion_payloads_replacement (id, source, source_url, season, hash, observed_at_utc, raw_json)
  SELECT id, source, source_url, season, hash, observed_at_utc, raw_json FROM ingestion_payloads;
DROP TABLE ingestion_payloads;
ALTER TABLE ingestion_payloads_replacement RENAME TO ingestion_payloads;
CREATE INDEX ingestion_payload_lookup ON ingestion_payloads(source, season, source_url, hash, observed_at_utc);

CREATE TABLE scenario_witnesses_replacement (
  job_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('qualifying','failing','qualifying_win_out','failing_win_out')),
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  witness_json TEXT NOT NULL,
  PRIMARY KEY (job_id, team_id, kind, sequence),
  FOREIGN KEY (job_id, team_id) REFERENCES scenario_statuses(job_id, team_id)
);
INSERT INTO scenario_witnesses_replacement (job_id, team_id, kind, sequence, witness_json)
  SELECT job_id, team_id, kind, 1, witness_json FROM scenario_witnesses;
DROP TABLE scenario_witnesses;
ALTER TABLE scenario_witnesses_replacement RENAME TO scenario_witnesses;

CREATE TRIGGER snapshot_poll_season_insert BEFORE INSERT ON snapshots
WHEN NEW.poll_release_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM poll_releases WHERE id = NEW.poll_release_id AND season = NEW.season
)
BEGIN SELECT RAISE(ABORT, 'snapshot poll season mismatch'); END;
CREATE TRIGGER snapshot_poll_season_update BEFORE UPDATE OF poll_release_id, season ON snapshots
WHEN NEW.poll_release_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM poll_releases WHERE id = NEW.poll_release_id AND season = NEW.season
)
BEGIN SELECT RAISE(ABORT, 'snapshot poll season mismatch'); END;
CREATE TRIGGER poll_release_season_update BEFORE UPDATE OF season ON poll_releases
WHEN EXISTS (SELECT 1 FROM snapshots WHERE poll_release_id = OLD.id AND season <> NEW.season)
BEGIN SELECT RAISE(ABORT, 'snapshot poll season mismatch'); END;
CREATE TRIGGER snapshot_game_season_insert BEFORE INSERT ON snapshot_games
WHEN NOT EXISTS (
  SELECT 1 FROM snapshots AS s JOIN games AS g ON g.id = NEW.game_id
  WHERE s.snapshot_key = NEW.snapshot_key AND s.revision = NEW.snapshot_revision AND s.season = g.season
)
BEGIN SELECT RAISE(ABORT, 'snapshot game season mismatch'); END;
CREATE TRIGGER snapshot_game_season_update BEFORE UPDATE OF snapshot_key, snapshot_revision, game_id ON snapshot_games
WHEN NOT EXISTS (
  SELECT 1 FROM snapshots AS s JOIN games AS g ON g.id = NEW.game_id
  WHERE s.snapshot_key = NEW.snapshot_key AND s.revision = NEW.snapshot_revision AND s.season = g.season
)
BEGIN SELECT RAISE(ABORT, 'snapshot game season mismatch'); END;
CREATE TRIGGER game_season_update BEFORE UPDATE OF season ON games
WHEN EXISTS (
  SELECT 1 FROM snapshot_games AS sg JOIN snapshots AS s
    ON s.snapshot_key = sg.snapshot_key AND s.revision = sg.snapshot_revision
  WHERE sg.game_id = OLD.id AND s.season <> NEW.season
)
BEGIN SELECT RAISE(ABORT, 'snapshot game season mismatch'); END;
CREATE TRIGGER snapshot_season_games_update BEFORE UPDATE OF season ON snapshots
WHEN EXISTS (
  SELECT 1 FROM snapshot_games AS sg JOIN games AS g ON g.id = sg.game_id
  WHERE sg.snapshot_key = OLD.snapshot_key AND sg.snapshot_revision = OLD.revision AND g.season <> NEW.season
)
BEGIN SELECT RAISE(ABORT, 'snapshot game season mismatch'); END;

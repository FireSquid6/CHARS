CREATE TABLE seasons (
  year INTEGER PRIMARY KEY CHECK (year >= 1869),
  state TEXT NOT NULL CHECK (state IN ('preseason','current','final','incomplete')),
  selection_freeze_utc TEXT,
  calendar_policy_version TEXT NOT NULL,
  coverage_json TEXT NOT NULL DEFAULT '{}'
);
CREATE TABLE teams (
  id TEXT PRIMARY KEY,
  provider_id TEXT UNIQUE,
  name TEXT NOT NULL,
  abbreviation TEXT
);
CREATE TABLE team_aliases (
  source TEXT NOT NULL,
  alias TEXT NOT NULL,
  team_id TEXT NOT NULL REFERENCES teams(id),
  PRIMARY KEY (source, alias)
);
CREATE TABLE team_seasons (
  season INTEGER NOT NULL REFERENCES seasons(year),
  team_id TEXT NOT NULL REFERENCES teams(id),
  membership TEXT NOT NULL CHECK (membership IN ('fbs','fcs','other')),
  conference TEXT,
  PRIMARY KEY (season, team_id)
);
CREATE TABLE ingestion_payloads (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  source_url TEXT NOT NULL,
  season INTEGER REFERENCES seasons(year),
  hash TEXT NOT NULL,
  observed_at_utc TEXT NOT NULL,
  raw_json TEXT NOT NULL,
  UNIQUE (source, hash)
);
CREATE TABLE games (
  id TEXT PRIMARY KEY,
  provider_game_id TEXT NOT NULL UNIQUE,
  season INTEGER NOT NULL REFERENCES seasons(year),
  week INTEGER CHECK (week >= 0),
  home_team_id TEXT NOT NULL REFERENCES teams(id),
  away_team_id TEXT NOT NULL REFERENCES teams(id),
  kickoff_utc TEXT,
  home_score INTEGER CHECK (home_score >= 0),
  away_score INTEGER CHECK (away_score >= 0),
  status TEXT NOT NULL CHECK (status IN ('scheduled','in_progress','completed','cancelled','postponed')),
  completed INTEGER NOT NULL CHECK (completed IN (0,1)),
  provider_season_type TEXT NOT NULL,
  application_game_type TEXT NOT NULL CHECK (application_game_type IN ('regular','ccg','bowl','playoff','unknown')),
  classification_source TEXT NOT NULL,
  first_seen_utc TEXT NOT NULL,
  last_seen_utc TEXT NOT NULL,
  payload_hash TEXT NOT NULL,
  result_revision INTEGER NOT NULL DEFAULT 1 CHECK (result_revision >= 1),
  CHECK (home_team_id <> away_team_id),
  CHECK ((completed = 1 AND status = 'completed' AND home_score IS NOT NULL AND away_score IS NOT NULL)
      OR (completed = 0 AND status <> 'completed' AND home_score IS NULL AND away_score IS NULL))
);
CREATE INDEX games_season_week ON games(season, week);
CREATE INDEX games_season_type_completed ON games(season, application_game_type, completed);
CREATE INDEX games_home_season ON games(home_team_id, season);
CREATE INDEX games_away_season ON games(away_team_id, season);
CREATE TABLE game_revisions (
  game_id TEXT NOT NULL REFERENCES games(id),
  revision INTEGER NOT NULL CHECK (revision >= 1),
  payload_id TEXT REFERENCES ingestion_payloads(id),
  payload_hash TEXT NOT NULL,
  observed_at_utc TEXT NOT NULL,
  previous_normalized_json TEXT,
  normalized_json TEXT NOT NULL,
  PRIMARY KEY (game_id, revision)
);
CREATE TABLE poll_releases (
  id TEXT PRIMARY KEY,
  season INTEGER NOT NULL REFERENCES seasons(year),
  poll_type TEXT NOT NULL CHECK (poll_type IN ('ap','cfp')),
  game_week INTEGER CHECK (game_week >= 0),
  released_at_utc TEXT,
  effective_at_utc TEXT,
  source_hash TEXT NOT NULL,
  payload_id TEXT REFERENCES ingestion_payloads(id)
);
CREATE INDEX poll_lookup ON poll_releases(season, poll_type, game_week, released_at_utc);
CREATE TABLE poll_entries (
  release_id TEXT NOT NULL REFERENCES poll_releases(id),
  team_id TEXT NOT NULL REFERENCES teams(id),
  rank INTEGER NOT NULL CHECK (rank >= 1),
  points REAL CHECK (points >= 0),
  PRIMARY KEY (release_id, team_id)
);
CREATE INDEX poll_entries_rank ON poll_entries(release_id, rank);
CREATE TABLE snapshots (
  snapshot_key TEXT NOT NULL,
  revision INTEGER NOT NULL CHECK (revision >= 1),
  season INTEGER NOT NULL REFERENCES seasons(year),
  week INTEGER CHECK (week >= 0),
  kind TEXT NOT NULL CHECK (kind IN ('partial','week_final','selection_final')),
  game_cutoff_utc TEXT NOT NULL,
  poll_cutoff_utc TEXT,
  poll_release_id TEXT REFERENCES poll_releases(id),
  input_hash TEXT NOT NULL,
  policy_version TEXT NOT NULL,
  model_version TEXT NOT NULL,
  calendar_policy_version TEXT NOT NULL,
  coverage_json TEXT NOT NULL,
  published_at_utc TEXT,
  PRIMARY KEY (snapshot_key, revision),
  UNIQUE (snapshot_key, revision, policy_version, model_version)
);
CREATE INDEX snapshots_season_cutoff ON snapshots(season, game_cutoff_utc, revision);
CREATE TABLE snapshot_games (
  snapshot_key TEXT NOT NULL,
  snapshot_revision INTEGER NOT NULL,
  game_id TEXT NOT NULL,
  game_revision INTEGER NOT NULL,
  PRIMARY KEY (snapshot_key, snapshot_revision, game_id),
  FOREIGN KEY (snapshot_key, snapshot_revision) REFERENCES snapshots(snapshot_key, revision),
  FOREIGN KEY (game_id, game_revision) REFERENCES game_revisions(game_id, revision)
);
CREATE TABLE snapshot_rankings (
  snapshot_key TEXT NOT NULL,
  snapshot_revision INTEGER NOT NULL,
  team_id TEXT NOT NULL REFERENCES teams(id),
  wins INTEGER NOT NULL CHECK (wins >= 0),
  losses INTEGER NOT NULL CHECK (losses >= 0),
  ties INTEGER NOT NULL CHECK (ties >= 0),
  rating REAL NOT NULL,
  residual REAL NOT NULL CHECK (residual >= 0),
  precision_method TEXT NOT NULL,
  colley_rank INTEGER NOT NULL CHECK (colley_rank >= 1),
  adjusted_rank INTEGER CHECK (adjusted_rank >= 1),
  eligible INTEGER NOT NULL CHECK (eligible IN (0,1)),
  eligibility_reason TEXT,
  original_route TEXT NOT NULL CHECK (original_route IN ('rating_bid','colley_minimum_bid','rating_playin','poll_playin','outside')),
  final_category TEXT NOT NULL CHECK (final_category IN ('bid','playin','outside')),
  PRIMARY KEY (snapshot_key, snapshot_revision, team_id),
  FOREIGN KEY (snapshot_key, snapshot_revision) REFERENCES snapshots(snapshot_key, revision)
);
CREATE TABLE selection_events (
  snapshot_key TEXT NOT NULL,
  snapshot_revision INTEGER NOT NULL,
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  event_type TEXT NOT NULL,
  winner_team_id TEXT REFERENCES teams(id),
  loser_team_id TEXT REFERENCES teams(id),
  details_json TEXT NOT NULL,
  PRIMARY KEY (snapshot_key, snapshot_revision, sequence),
  FOREIGN KEY (snapshot_key, snapshot_revision) REFERENCES snapshots(snapshot_key, revision)
);
CREATE TABLE bracket_slots (
  snapshot_key TEXT NOT NULL,
  snapshot_revision INTEGER NOT NULL,
  round INTEGER NOT NULL CHECK (round >= 0),
  position INTEGER NOT NULL CHECK (position >= 0),
  seed INTEGER CHECK (seed >= 1),
  team_a_id TEXT REFERENCES teams(id),
  team_b_id TEXT REFERENCES teams(id),
  source_slot_a TEXT,
  source_slot_b TEXT,
  is_bye INTEGER NOT NULL DEFAULT 0 CHECK (is_bye IN (0,1)),
  PRIMARY KEY (snapshot_key, snapshot_revision, round, position),
  FOREIGN KEY (snapshot_key, snapshot_revision) REFERENCES snapshots(snapshot_key, revision)
);
CREATE TABLE scenario_jobs (
  id TEXT PRIMARY KEY,
  snapshot_key TEXT NOT NULL,
  snapshot_revision INTEGER NOT NULL,
  poll_model_version TEXT NOT NULL,
  solver_version TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','running','proved','unsupported')),
  checkpoint_json TEXT,
  created_at_utc TEXT NOT NULL,
  updated_at_utc TEXT NOT NULL,
  UNIQUE (snapshot_key, snapshot_revision, poll_model_version, solver_version, input_hash),
  FOREIGN KEY (snapshot_key, snapshot_revision) REFERENCES snapshots(snapshot_key, revision)
);
CREATE TABLE scenario_statuses (
  job_id TEXT NOT NULL REFERENCES scenario_jobs(id),
  team_id TEXT NOT NULL REFERENCES teams(id),
  state TEXT NOT NULL CHECK (state IN ('pending','running','proved','unsupported')),
  label TEXT CHECK (label IN ('clinched','eliminated','controls_destiny','needs_help')),
  assumptions_json TEXT NOT NULL,
  proof_metadata_json TEXT,
  runtime_ms INTEGER CHECK (runtime_ms >= 0),
  PRIMARY KEY (job_id, team_id),
  CHECK (state <> 'proved' OR label IS NOT NULL)
);
CREATE INDEX scenario_statuses_team ON scenario_statuses(team_id, job_id);
CREATE TABLE scenario_witnesses (
  job_id TEXT NOT NULL,
  team_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('qualifying','failing','qualifying_win_out','failing_win_out')),
  witness_json TEXT NOT NULL,
  PRIMARY KEY (job_id, team_id, kind),
  FOREIGN KEY (job_id, team_id) REFERENCES scenario_statuses(job_id, team_id)
);
CREATE TABLE sync_runs (
  id TEXT PRIMARY KEY,
  scheduled_key TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('running','success','failure')),
  started_at_utc TEXT NOT NULL,
  ended_at_utc TEXT,
  counts_json TEXT NOT NULL DEFAULT '{}',
  error TEXT
);
CREATE TABLE job_leases (
  name TEXT PRIMARY KEY,
  owner TEXT NOT NULL,
  expires_at_utc TEXT NOT NULL
);

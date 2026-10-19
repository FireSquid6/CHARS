ALTER TABLE scenario_jobs ADD COLUMN input_generation INTEGER;
ALTER TABLE scenario_jobs ADD COLUMN lease_owner TEXT;
ALTER TABLE scenario_jobs ADD COLUMN lease_expires_utc TEXT;
ALTER TABLE scenario_jobs ADD COLUMN evaluated_completions INTEGER NOT NULL DEFAULT 0 CHECK (evaluated_completions >= 0);
ALTER TABLE scenario_jobs ADD COLUMN budget_json TEXT NOT NULL DEFAULT '{}';
CREATE INDEX scenario_jobs_work ON scenario_jobs(snapshot_key, state, lease_expires_utc);

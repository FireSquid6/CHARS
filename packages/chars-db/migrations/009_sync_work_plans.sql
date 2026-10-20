ALTER TABLE scenario_work_queue ADD COLUMN next_eligible_utc TEXT;
ALTER TABLE sync_runs ADD COLUMN planned_current_season INTEGER;
ALTER TABLE sync_runs ADD COLUMN planned_recent_seasons INTEGER;
ALTER TABLE sync_runs ADD COLUMN planned_timezone TEXT;

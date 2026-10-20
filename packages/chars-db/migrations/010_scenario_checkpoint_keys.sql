CREATE TABLE scenario_job_secrets (
  job_id TEXT PRIMARY KEY REFERENCES scenario_jobs(id) ON DELETE CASCADE,
  secret_hex TEXT NOT NULL CHECK (length(secret_hex) = 64)
);

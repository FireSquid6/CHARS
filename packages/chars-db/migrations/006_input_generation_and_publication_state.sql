CREATE TABLE season_input_generations (
  season INTEGER PRIMARY KEY REFERENCES seasons(year),
  generation INTEGER NOT NULL CHECK (generation >= 1)
);
INSERT INTO season_input_generations (season, generation) SELECT year, 1 FROM seasons;
ALTER TABLE snapshot_publications ADD COLUMN state TEXT NOT NULL DEFAULT 'current'
  CHECK (state IN ('current','pending','stale'));

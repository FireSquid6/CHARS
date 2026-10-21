-- Run as a database owner before running one-off/backfill-game-types.ts.
-- A CHECK constraint permits NULL (unknown), and existing rows remain NULL.
ALTER TABLE public.games ADD COLUMN IF NOT EXISTS game_type text;
ALTER TABLE public.games DROP CONSTRAINT IF EXISTS games_game_type_check;
ALTER TABLE public.games ADD CONSTRAINT games_game_type_check
  CHECK (game_type IN ('regular', 'ccg', 'playoff', 'bowl'));

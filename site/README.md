# CHARS — College Football Archive

Browse FBS seasons, records and regular-season team schedules powered by the `chars-db` SQLite package.

1. Copy `.env.example` to `.env.local` and set `DATABASE_PATH` to the **absolute path** of an existing migrated SQLite database. The local development database is `/home/firesquid/data/cfbdb.sqlite`.
2. From the repository root, run `bun install` and `bun run --cwd site dev`.
3. Visit [http://localhost:3000](http://localhost:3000).

The Next.js server **must run under Bun** to support `bun:sqlite` (the `dev`, `build`, and `start` scripts do this automatically). Data is read on each request, so database updates do not require a rebuild. Only regular-season games belong in the database; records include all opponents, while standings and team pages are limited to FBS teams.

Verify with `bun run --cwd site build`, `bun run --cwd site lint`, and `bun test` from the repository root.

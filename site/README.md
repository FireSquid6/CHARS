# CHARS — College Football Archive

Browse FBS seasons, records and regular-season team schedules powered by the existing PostgreSQL `cfbdb` database.

1. Copy `.env.example` to `.env.local` and set `DATABASE_URL` to a connection string for `cfbdb`. For peer authentication through a Unix socket, also set `DATABASE_SOCKET` to the socket filename and use the matching username in the URL.
2. From the repository root, run `bun install` and `bun run --cwd site dev`.
3. Visit [http://localhost:3000](http://localhost:3000).

The Next.js server **must run under Bun** to support `Bun.sql` (the `dev`, `build`, and `start` scripts do this automatically). Data is read on each request, so database updates do not require a rebuild. Only regular-season games belong in the database; records include all opponents, while standings and team pages are limited to FBS teams.

Verify with `bun run --cwd site build`, `bun run --cwd site lint`, and `bun test` from the repository root.

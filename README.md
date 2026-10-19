# CHARS

Bun monorepo with a Next.js application and shared packages.

## Structure

- `site/` — Next.js App Router application with TypeScript, Tailwind CSS, and ESLint.
- `packages/chars-algorithm/` — shared domain contracts and pinned policy/model identities; algorithm implementations follow in later steps.
- `packages/chars-db/` — server-only Bun SQLite connection, SQL migrations, and prepared repository primitives.
- `packages/*/` — additional workspace packages (each needs a `package.json`).

## Development

Use Bun 1.3.14. From the repository root:

```sh
bun install
bun run dev
```

Open http://localhost:3000. The site currently contains only the starter UI; no live data is available yet.

```sh
bun run build
bun run start
bun run lint
bun run typecheck
bun test
```

Dependencies and the shared `bun.lock` are managed from the repository root.
When a package is ready to be consumed, add it to the consuming workspace's
dependencies with the `workspace:*` version range.

## Database setup

Copy `.env.example` to `.env` and configure a persistent **absolute** `DATABASE_PATH`, then run:

```sh
DATABASE_PATH=/absolute/path/to/chars.sqlite bun run db:migrate
```

The migration command does not require `CFBD_API_KEY`. Bun's SQLite connection enables WAL, foreign keys, and a configurable busy timeout (`SQLITE_BUSY_TIMEOUT_MS`, default 5000). Only server-side code should import `chars-db`; browser components consume domain output, not a SQLite connection. Migrations are versioned under `packages/chars-db/migrations/` and recorded in `schema_migrations`. Offline tests create and remove their own temporary databases. Database files and WAL/SHM sidecars are ignored by git. Never place the API key in a public environment variable; fetching and the scheduler are not implemented in this step.

## Scenario worker

With a published, current non-final snapshot and a verified pre-freeze schedule:

```sh
DATABASE_PATH=/absolute/path/to/chars.sqlite bun run scenarios:solve --snapshot '2026:week:8'
```

Each invocation **restarts enumeration from zero**: prefix/cursor resumption is disabled because an unverified checkpoint could falsely prove a label. A short run stays pending; increasing the per-run budget is required to finish. `SCENARIO_MAX_COMPLETIONS` (default 1000), `SCENARIO_MAX_RUNTIME_MS` (default 5000), and `SCENARIO_MAX_TRACKED_POLL_PATHS` (default 10000) bound each invocation. The job stores a lease, last-attempt progress, witnesses, revision/input-generation hash and an atomic final publication. Witnesses from prior partial attempts are replaced, never used as proof. Missing coverage or stale input cannot yield a label. The only early proof implemented is an exact maximum-record-below-.750 elimination; other classifications require exhaustive game/poll-equivalence enumeration. Optional `--allow-historical-ties` applies only before 1996 (the configured 1998+ production scope therefore never uses it). No verified resumable DFS frontier, conservative Colley/selection branch bounds, or game-outcome coefficient solver have been implemented yet. The synthetic benchmark (`bun packages/chars-algorithm/tests/scenarios.benchmark.ts`) has 134 FBS teams and 536 future games: it is *not* a real season or a full-schedule completion certificate. Most early-season teams remain pending within finite budgets; do not present weekly statuses as universally solved.

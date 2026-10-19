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

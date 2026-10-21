# CHARS CLI

Read-only command-line access to the same PostgreSQL `cfbdb` archive as the website. Requires Bun and `DATABASE_URL`; for peer-authenticated local PostgreSQL, also set `DATABASE_SOCKET` to the full socket filename. The CLI does not use the website and does not run migrations.

## On `minibox-one`

This checkout has a local, **git-ignored** `cli/.env` (mode `0600`) with the `cfb_reader` connection for the existing `cfbdb` server. It was copied from the owner-only credential file at `/home/firesquid/documents/cfb-postgres-migration/credentials/cfb-reader.env`. The connection uses password-authenticated TCP, not the local peer-authenticated socket. Do not commit, paste, log, or send the env file or its URL to an agent or a shared session. The reader role is for queries only; do not use this connection for migrations or imports.

For another agent running as `firesquid` in **this checkout**, from the repository root after `bun install`:

```sh
bun run cli sql 'SELECT current_user AS role, current_database() AS database' --format json
bun run cli seasons
bun run cli standings 2025
bun run cli team 2025 'Ohio State'
bun run cli schedule 2025 'Ohio State' --format csv
```

`bun run cli` launches the CLI workspace and Bun loads `cli/.env` automatically. Each worktree is separate: in a **different checkout on minibox-one**, copy the existing protected credential into that checkout's ignored env file as `firesquid`, without printing its contents:

```sh
install -m 600 /home/firesquid/documents/cfb-postgres-migration/credentials/cfb-reader.env cli/.env
bun run cli sql 'SELECT current_user AS role, current_database() AS database' --format json
```

The check should show `cfb_reader` and `cfbdb`. If running as another OS user without access to the protected credential, ask the operator for authorized access rather than changing permissions. Verify `git check-ignore cli/.env` before any commit. For a direct command run from the repository root instead of `bun run cli`, explicitly load the env file: `bun --env-file=cli/.env cli/src/main.ts seasons`.

## Other environments

Set up your own `DATABASE_URL` for `cfbdb` (and `DATABASE_SOCKET` if using a peer-authenticated socket). Do not copy minibox-one credentials to another machine. For example, once the environment variables are exported:

```sh
bun run cli --help
bun run cli seasons
bun run cli standings 2025
bun run cli team 2025 'Ohio State'
bun run cli schedule 2025 'Ohio State' --format csv
bun run cli sql 'SELECT team_name FROM teams ORDER BY team_name LIMIT 5' --format json
```

Alternatively, run `bun cli/src/main.ts ...` or use the `chars` bin from the workspace installation. The global `--format table|json|csv` option applies to every command. Team arguments match an FBS team's ID, full name, or abbreviation (case-insensitively) in the requested season. `sql` accepts a single row-returning SELECT, wrapped as a derived table in a read-only transaction. It cannot run DDL or DML; use a database role with SELECT-only privileges as an additional safeguard. SQL parameters should be supplied via the named browse commands rather than interpolating untrusted input into a `sql` argument.

Errors and invalid input produce a nonzero exit status. The CLI does not import Next.js or make HTTP requests.

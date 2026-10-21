# CHARS

> **Current checkout:** The archive site and the [read-only CLI](cli/README.md) query the existing PostgreSQL `cfbdb` database. See [site/README.md](site/README.md) and [packages/chars-db/README.md](packages/chars-db/README.md) for current setup. The SQLite migration, backup, and deployment instructions in the historical design notes below do **not** apply; do not run them against `cfbdb`.

Hypothetical college-football playoff site: Next.js App Router, Bun, SQLite, CFBD ingestion, Colley ratings, selection and bracket, with separately scheduled scenario proofs. Synthetic test fixtures are not historical season data. No team logos are used.

## Local setup

Use the pinned package versions in `site/package.json`, the committed `bun.lock`, and Bun **1.3.14** (`packageManager`); verify `bun --version` before deploying. Install with `bun install --frozen-lockfile`. Copy `.env.example` to `.env` (never commit it). Set `DATABASE_PATH` to an **absolute, durable** path in an existing writable directory, and set `CFBD_API_KEY` to a valid server-side CollegeFootballData bearer key. Do not use `NEXT_PUBLIC_`, expose the key in a URL/log, or put SQLite on an ephemeral/serverless or network-shared volume. The offline tests, migrations and unpopulated site do not need a key; ingestion without one fails explicitly. The UI shows a setup/data gap instead of inventing rankings. Configure `SQLITE_BUSY_TIMEOUT_MS` (default 5000) and `START_SEASON` (default 1998) as needed.

```sh
bun run db:migrate
bun run data:backfill --season 2025
bun run data:backfill --from 1998 --to CURRENT
bun run snapshots:rebuild --season 2025
bun run data:sync --manual
bun run data:sync --status
bun run data:sync --retry daily:2026-10-19
bun run scenarios:solve --snapshot '2026:week:8'
bun run scenarios:work 1
bun run dev
```

`data:backfill` ingests one season or a range but does **not** itself publish snapshots: run `snapshots:rebuild --season YEAR` for each backfilled year, or `data:sync --manual` to reconcile the active season and build its snapshots. The current football season convention is July–June in the configured `SYNC_TIMEZONE` (default America/Chicago), not the calendar year in January; inspect coverage and selection calendar before relying on historical outputs. `data:sync` reconciles the active season daily, plus the last two seasons on Sunday; manual sync includes the last two. Network calls validate before writes, and a failed sync leaves the last published revision available. Repeating a successful daily key is a no-op. The CFBD client retries bounded transient errors/429s and honors bounded Retry-After; a longer provider deferral becomes a failed run for a later scheduler wakeup. Monitor account quota and avoid concurrent manual backfills/syncs.

```sh
bun test
bun run typecheck
bun run lint
bun run build
bun run start
```

## Single-host deployment (systemd)

The files in `deploy/` are a **single host** example, not a live deployment. Install Bun 1.3.14 as `/usr/local/bin/bun`; put this checkout at `/opt/chars` and create a `chars` system user, `/var/lib/chars` owned by that user (durable local disk), and `/etc/chars/chars.env` readable only by that user/root (`0600`). Set `DATABASE_PATH=/var/lib/chars/chars.sqlite`, `CFBD_API_KEY=...`, `SYNC_TIMEZONE=America/Chicago` and scenario budgets in that env file. Limit host access to the volume/backups; keep both out of git and never serve them as web assets. `bun install --frozen-lockfile`, `bun run build`, and `bun run db:migrate` before starting. The build must be produced with the `chars` user (or hand off ownership afterwards): `chars` needs read access to all of `/opt/chars`, and write access to `/opt/chars/site/.next` for Next's runtime cache under the unit's `ProtectSystem=strict` sandbox. For example, after a root-owned build, `chown -R chars:chars /opt/chars/site/.next`; ensure that directory exists before starting the service. `/var/lib/chars` and `/var/backups/chars` must likewise be writable by `chars` (the backup service is run manually). Run migrations with **site and timers stopped** on upgrades, after taking a verified backup. The service working directory and Bun path are explicit; adjust if installing elsewhere.

Copy `deploy/*.service` and `deploy/*.timer` to `/etc/systemd/system/`, run `systemctl daemon-reload`, then `systemctl enable --now chars-site.service chars-sync.timer chars-scenarios.timer`. For interactive commands below, run as `chars` with `DATABASE_PATH` and other settings exported from its protected env file (for example, in a trusted shell: `set -a; . /etc/chars/chars.env; set +a`); systemd's `EnvironmentFile` is **not** automatically inherited by your shell. Put a TLS-terminating reverse proxy in front of the site on `127.0.0.1:3000`, limiting request rates and size. No proxy/API endpoint is needed for the scheduler. The web process, the sync one-shot and the scenario one-shot use the **same local SQLite file**; one sync writer is controlled by its DB lease, and scenario jobs have separate revision-scoped leases. Do not scale site/writer to independently writable database copies or put SQLite on NFS. Use WAL and bounded SQLite readers. The site dynamically reads published revisions rather than running sync/search in requests; do not CDN-cache dynamic season pages without explicit invalidation. A single Next instance avoids multi-instance cache coordination.

`chars-sync.timer` invokes `data:schedule` at **00:00 America/Chicago** using the IANA timezone in `OnCalendar`, including DST changes, without requiring site traffic. `Persistent=true` catches a missed calendar activation after downtime; boot and 30-minute idle wakeups retry failed/expired runs and reconcile the current day (successful daily keys skip network work). At most **one** catch-up key plus the current day is attempted per wakeup; old failed/unfinished daily keys remain retryable beyond 48 hours, keeping their original stored season/range plan. Failed current and prior runs cool down for two hours before another automatic attempt. If Sunday was missed while offline, the latest missed Sunday is reconciled with its two recent seasons; multiple missed Sundays coalesce into that one full fetch. Once it succeeds, older failed runs can be retried at later wakeups. This avoids replaying every missed day or stampeding the provider in one activation; watch quota and use manual retry if history is unusually large. Stored timestamps are UTC; the daily key is the local date. For a different zone, set `SYNC_TIMEZONE` **and** replace `America/Chicago` in the timer's `OnCalendar` with the same valid IANA zone; `systemctl daemon-reload && systemctl restart chars-sync.timer`, and check `systemd-analyze calendar '*-*-* 00:00:00 Your/Zone'`. A timer calling sync and a manual sync at once cannot overlap through the DB lease. A lease is one hour: very long stalled runs may lose their lease and fail safely; investigate if recurring.

`chars-scenarios.timer` wakes the separate queue worker after boot and every two idle minutes. Each invocation handles **one** revision-scoped job, with per-run time/completion/poll-path limits, then exits. Pending jobs are retried after a short delay; expired leases are recovered. No `setInterval`, browser event, or Next request is used to drive either job. Set `SCENARIO_MAX_RUNTIME_MS` below the 15-minute service timeout (default 5000), `SCENARIO_MAX_COMPLETIONS` (default 1000), `SCENARIO_MAX_TRACKED_POLL_PATHS` (default 10000), and `SCENARIO_MAX_CHECKPOINT_BYTES` (default 16777216). Frontier size is conservatively charged before each leaf; these are **not** process-wide memory limits. Reaching either memory cap produces an unsupported computation with no invented labels and stops queue retries; raise the relevant cap and run `scenarios:solve --snapshot KEY` manually to resume. Do not raise it beyond host memory/disk constraints. Legacy `SCENARIO_CPU_BUDGET_MS`/`SCENARIO_MEMORY_BUDGET_MB` entries in `.env.example` are operator sizing hints, **not** enforced process limits.

### Health and recovery

Check `systemctl status chars-site chars-sync.timer chars-scenarios.timer`, `systemctl list-timers 'chars-*'`, `journalctl -u chars-sync.service -u chars-scenarios.service -n 100`, `bun run data:sync --status` (lease, last run, last success, pending scenario count), and `curl -f http://127.0.0.1:3000/`. The site displays last successful sync, incomplete/stale publication, and pending status independently of playoff labels. `bun run data:sync --retry daily:YYYY-MM-DD` retries a failed date under its original planned season range; `--manual` creates a new distinct run (and fetches recent seasons). Do not repeatedly force manual requests into CFBD quota limits. A failure does not justify deleting a lease or changing published data; wait for lease expiry and inspect errors. `bun run scenarios:work 1` handles one queued item on demand. For historical backfill, budget requests and rebuild each imported season explicitly.

### WAL-consistent backup and restore

Do **not** copy only the live `.sqlite` file: committed changes may still be in `-wal`. From the configured host, with the DB directory on durable storage:

```sh
bun run db:backup /var/backups/chars/chars-2026-10-19.sqlite
```

The command uses SQLite `VACUUM INTO` on a read-only source connection; it captures committed WAL transactions into a new consistent database, checks `PRAGMA integrity_check` and `foreign_key_check`, fsyncs the staged file, and atomically publishes to a **new** destination (never overwrites a backup), fsyncing its parent directory after publication and staging cleanup. Keep backups in a protected directory owned by `chars`, off-host encrypted copies with retention and restore drills; backups contain full raw provider payloads. Enough free disk space for another database is required. Writes occurring after the backup snapshot are not included.

Restore only after stopping **all** DB users, including both timers and the web process; plan downtime:

```sh
systemctl stop chars-sync.timer chars-scenarios.timer chars-site.service
# wait until any running oneshot services finish, then stop them too
systemctl stop chars-sync.service chars-scenarios.service
# archive /var/lib/chars/chars.sqlite AND any chars.sqlite-wal / chars.sqlite-shm together
# to a protected rollback location on the same host; do not delete uncheckpointed WAL
bun run db:restore /var/backups/chars/chars-2026-10-19.sqlite
bun run db:migrate
systemctl start chars-site.service chars-sync.timer chars-scenarios.timer
```

`db:restore` refuses any existing target or WAL/SHM sidecars; it verifies source and staged copy, fsyncs the staged file, and atomically places a fresh DB at `DATABASE_PATH`, fsyncing the directory after publication and staging cleanup. Restore into a **new empty target**, never over a live database. The operator must archive the old three-file set before restoring and ensure the backup file is readable by `chars`. Verify health and a season page before discarding the rollback set. Migrations run after restore to bring an older backup forward; test this path in a staging directory first.

## Rules and limits

Pinned identities: `selection-v1`, `colley-fbs-only-v1`, `pre-ccg-weekend-v1`, `all-eligible-poll-orders-v1`. FBS-only Colley uses completed FBS–FBS regular games; FCS regular results count for .750 eligibility, not the rating matrix. This does **not** reproduce published Colley rankings with an FCS grouping. Zero-game teams are ineligible; at least .90 initially bids, at least .85 initially reaches play-in, top eligible Colley teams fill to four bids, and a contemporaneous eligible AP/CFP poll fills toward (not necessarily to) twelve. Before CFP releases, AP is provisional fallback; final 2014+ uses pre-CCG CFP. Ineligible published poll entries are retained but cannot enter the field. Clean head-to-head requires at least one win, no loss or tie in the series; cycles among **all** FBS teams use SCC-wide Colley fallback. Outsiders can enter only via play-in and then compete for a direct bid; category swaps preserve counts. Odd play-in pools give the highest adjusted invite a bye. Play-in winner slots are fixed without reseeding. Freeze is after the last full regular weekend before the first CCG; historical poll timing can be a documented derived convention, not an archived release timestamp. Classification/coverage ambiguity is a gap, not evidence of elimination.

Weekly labels quantify fixed known future schedules and all eligible terminal poll orders, not predictions. The solver stores a revision-scoped mixed-radix game/poll-subset cursor, witness accumulator and same-game poll-dependence pairs; retries continue at the next unevaluated leaf. Each job's checkpoint is signed with HMAC-SHA-256 using a random key stored in a **separate** `scenario_job_secrets` table, not supplied by the checkpoint/public input. The pure API refuses checkpoint resumption without a separately supplied privileged verifier key. A public SHA digest or attacker-chosen key cannot authenticate a worker checkpoint; mismatched input/model identity and nonmonotone DB counts are rejected. A DB administrator with read access to the private key can still forge its MAC: protect the whole DB and its backups. Record bounds prove impossible eligibility; when at most twelve teams can possibly be eligible, every eligible team necessarily enters via the eligible poll top-up, proving clinch or win-out control without a game search. Where CPU permits, a bound proof includes a terminal qualifying witness checked against the selection engine; otherwise its metadata explicitly says no witness was materialized. No other general Colley/head-to-head bound is implemented. A completion/runtime exhaustion remains pending/unproved, never a fabricated bubble. Run `bun packages/chars-algorithm/tests/scenarios.benchmark.ts` for an offline synthetic 134-team, 804-game, twelve-distinct-opponent schedule. At rounds 0/4/8/11, with 804/536/268/67 games remaining and a one-leaf budget, the measured proved-eliminated/pending counts were 0/134, 6/128, 84/50 and 110/24 (approximately 242/225/202/204 ms, Bun 1.4.0); no other labels were proved. Even 67 remaining games have 2^67 result paths before poll choices. This **does not** meet full early-season weekly classification: real schedules/polls may be harder, and additional sound selection/rating pruning is still needed. The four-label coverage exception is checked on small schedules but no constructive exception is known; absent a proof of monotonicity it remains a policy risk. Missing data remain distinct from proved playoff status.

Browser smoke checklist: home links through the configured current season, weekly selector/previous/next URL history, final bracket alternatives, status filters and search, keyboard tab/Enter navigation, narrow mobile table scrolling and bracket labels. Verify no logo files/requests, no browser API key, and that an unpopulated or keyless site reports setup instead of ranking guesses. Offline `bun test` covers migrations, selection/scenario fixtures, sync revisions, DST keys, WAL backup/restore and migration after restore; run visual browser checks against a populated deployment as a separate acceptance step.

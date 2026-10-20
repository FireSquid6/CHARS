# CHARS

An experimental Bun/Next.js playoff site with an offline Colley engine. This branch's CFBD importer targets the **existing** SQLite schema. It does not change or migrate that schema.

## Setup

Install Bun and run `bun install --frozen-lockfile`. Copy `.env.example` to a protected `.env`; set an absolute `DATABASE_PATH`, an absolute durable `CHARS_CACHE_PATH`, and server-only `CFBD_API_KEY`. Never use `NEXT_PUBLIC_` for the key. Create the DB and cache parent directories; run `bun run db:migrate` before importing. `.cache`, database files and `.env` are git-ignored. The CLI must receive the environment through the service's `EnvironmentFile` or `bun --env-file=.env run ...`.

```
bun run data:backfill --season 2025
bun run data:backfill --from 1998 --to CURRENT
bun run snapshots:rebuild --season 2025
bun run data:sync --manual
bun run data:sync --status
bun run data:sync --retry daily:2026-10-19
bun test
bun run typecheck
bun run lint
bun run build
```

The July–June football-season convention is a configured-timezone approximation, **not** provider season metadata. Backfill stores inputs but does not publish snapshots. Automatic sync attempts current-season publication only after ingestion without reported coverage gaps. Calendar freeze needs separate operator verification in `.cache/source/YEAR-calendar.json`; this importer does not invent it. Poll week starts are derived upper bounds, not actual publication timestamps; review before representing a historical poll as contemporaneous. Ambiguous classification, missing games, absent poll or unresolved opponent identity leave explicit gaps instead of fabricated results. API absence or failed/empty response fails closed without deleting the previous snapshot.

The unchanged `games` table holds regular-season rows only. Raw responses, game completion/classification, postseason calendar evidence, hashes and prior audited observations live in `CHARS_CACHE_PATH/source`; revision copies are under `source/revisions`. Each SQLite upsert is transactional, but SQLite and filesystem publication are **not** one transaction. A crash after DB commit can leave a `YEAR-pending.json` journal; inspect it and reconcile the database and sidecars before removing it and retrying. Do not serve incomplete data as a verified final. There is no scenario proof worker or cross-store atomic generation protocol in this branch; weekly status remains pending. Rebuild can publish incomplete weekly snapshots; only operator-verified calendar, classification and poll coverage permit a final snapshot.

## Single-host scheduling and recovery

The `deploy/chars-sync.timer` runs at midnight `America/Chicago` with `Persistent=true`; it also wakes periodically after boot for retries. The associated service runs outside Next.js and must use the same durable local SQLite/cache volume as the web process. Configure `SYNC_TIMEZONE=America/Chicago`, `CHARS_CACHE_PATH=/var/lib/chars/cache`, and `DATABASE_PATH=/var/lib/chars/chars.sqlite` in `/etc/chars/chars.env`, with owner-only access. A different timezone requires changing **both** env and timer `OnCalendar`. Daily keys use the local date, including DST changes; Sundays and manual runs also reconcile two prior seasons. A filesystem lease in the durable cache prevents ordinary overlapping writers; a stale lease is recovered after three hours, but this is not a database lease and should not be treated as one across separate hosts. Check `bun run data:sync --status`, systemd logs, the sidecar journal and source audit on failure. `--retry daily:YYYY-MM-DD` uses the prior run's season list; `--manual` creates a new run. Keep a single host/writer; do not use NFS or independently writable replicas.

Run `bun run db:backup /absolute/new/protected/backup.sqlite` for a WAL-consistent SQLite `VACUUM INTO` backup; it checks integrity/foreign keys before publishing to a **new** path. Separately archive `CHARS_CACHE_PATH` with the sync worker stopped so sidecars and snapshots are retained. Do not copy only a live `.sqlite` file: committed data may still be in `-wal`. Restore with all users stopped to a fresh target and verify both database and cache before restart. This branch does **not** provide an automated restore command.

## Limits

Source API schemas are validated offline with fixtures, but live CFBD historical coverage and release-time behavior require operator verification. Team IDs are numeric provider IDs; no fuzzy aliases or division classifications are invented. Opponents with unverified membership fail ingestion. Poll corrections and game changes invalidate the newly built snapshots by content hash; there is no fine-grained scenario invalidation. Exact all-schedule/all-poll mathematical status remains unimplemented and must not be represented as a proven label.

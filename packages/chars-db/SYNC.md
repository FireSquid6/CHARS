# Data sync (Step13)

`bun run data:sync` runs the daily ingestion path once per local calendar day. A separate
scheduler must invoke it at midnight with `SYNC_TIMEZONE=America/Chicago` (or an explicit
IANA override); this command does not install a scheduler or run inside Next.js. UTC
timestamps and a `daily:YYYY-MM-DD` local-date key are persisted in `sync_runs`. Use
`bun run data:sync --manual` for an immediate independent run, `--retry daily:YYYY-MM-DD`
to retry a failed key, and `--status` to inspect the lease, last run and queue depth.
Successful scheduled keys are not rerun. Do not use a manual key as a substitute for a
scheduled invocation.

One SQLite lease fences overlapping sync commands; an expired lease and its abandoned
run are recovered by the next command. Fetches (including CFBD's bounded 429/5xx
retries) occur outside write transactions. The normal daily pass fetches six CFBD
requests for the active season (two games, two team endpoints, rankings, calendar).
On Sundays, the two preceding seasons are also reconciled (18 requests total); manual
runs do the same. This schedule is a quota tradeoff and can be changed in code. Empty
games for an already populated season fail without replacing it. Missing individual
games do not imply cancellation. `ingestion_payloads` retain raw observations and
`sync_runs` records failure/counts. A failed rebuild retains the previous published
revision; its state can be pending/stale until successfully rebuilt.

Each successful sync queues revision-scoped non-final snapshots in
`scenario_work_queue`; run `bun run scenarios:work` independently, with an optional
bounded job count argument. Scenario failures or solver budgets cannot block snapshot
publication. Expired scenario work leases are reclaimable, with at most three attempts.
This worker performs one bounded solver attempt per queued revision and does not
automatically schedule itself: the deployment scheduler should invoke it separately.
Old revision queue entries are ignored when a newer revision is published.

Limitations: no site-cache purge integration is supplied here; server views should
revalidate after publication. Snapshot reconstruction itself still traverses calendar
plans to check validity, but skips expensive rebuild for unchanged earlier cutoffs.
The daily worker is not a substitute for Step14's timezone-aware deployment scheduler.

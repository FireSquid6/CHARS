# CHARS implementation checklist

`PROJECT.md` is the full product/policy specification. This checklist tracks implementation, not a claim of completion. Synthetic tests are not historical validation.

## 1. Pure model and playoff engine

- [x] FBS-only Colley matrix, deterministic indexing, Cholesky solver, residual checks, exact comparison fallback, season-scoped records and FCS eligibility accounting.
- [x] Exact .750 eligibility; .90 bids, minimum-four bids, .85 play-ins, eligible contemporaneous-poll top-ups, and original routes.
- [x] Clean head-to-head edges, full-FBS SCC suppression, deterministic two-boundary swaps, selected-team topological seeding and cycle fallback.
- [x] Odd play-in bye, high/low pairings, fixed winner slots, seeded elimination bracket and synthetic tests.
- [ ] Integrate with authenticated, season-scoped real inputs; verify historical seasons against source data. No real-season or final-publication guarantee comes from the pure engine alone.

## 2. Persistent inputs, snapshots and backfill

- [ ] **Schema constraint: do not replace or alter the existing SQLite schema/migrations without explicit approval.** Existing tables lack completion/classification, revision, snapshot and lease columns. An ignored `.cache` file store is allowed for typed source metadata and atomic JSON snapshot publication without changing tables; this implements a limited audited retrospective read path, not transactional SQLite publication, a durable scheduler, or proved status. Design approved additive migrations or a more robust coordinated external store before claiming the entire product complete.
- [ ] Validate live CFBD games, membership, calendar and poll schemas; server-only API key, authenticated fetch, canonical IDs/aliases, season-specific FBS/FCS membership and data provenance.
- [ ] Backfill 1998 through provider/calendar-derived current season, including schedules, FCS opponents, season-specific poll releases and coverage gaps; provide absent-key setup/error state and `.env.example`.
- [ ] Pre-CCG freeze requires an operator-verified calendar and complete classification; retrospective weekly builder isolates completed games by kickoff/week and polls by release/week, with provisional AP fallback and explicit gaps. Historical completion times, current partial weeks, comprehensive schedule coverage validation and provider-derived calendars remain unimplemented.
- [ ] Typed read-only bun:sqlite repository and content-addressed JSON artifacts with atomic manifest replacement, hashes and coverage/pending indicators are implemented in `packages/chars-db/src/`. SQLite revisions, transactional coordination with source writes, live cache invalidation and stale status remain open.

## 3. Website and bracket UI

- [ ] Home list for 1998–current season including preseason/current/final/incomplete and working season links.
- [ ] Season page: latest or frozen final selection by default, shareable `?week=` controls and history; complete FBS table, search, eligible/ineligible records, ranks, rating boundaries, routes, swaps and short-field explanations.
- [ ] Accessible final bracket with alternatives/byes/fixed seeds; no logos or real-world winner substitution. Non-final view: four bubble filters/counts, team details, witnesses, and clearly separate pending/unproved/data states.
- [ ] Responsive, keyboard and screen-reader/browser tests; no API keys in assets; server-render from published results only.

## 4. Exact scenarios and status proofs — computational limitation

- [ ] Implement shared-game terminal completions with fixed known schedule, FCS record bounds, eligible-only all-poll-order model, win-out quantifiers and the four ordered statuses. Reuse the same selection/bracket engine; handle historical ties where permitted.
- [ ] Detect the four-label coverage exception; retain proofs, qualifying/failing and win-out witnesses, poll-dependent help, and explicit assumptions. Never mislabel an unproved case as eliminated or clinched.
- [ ] Build a sound resumable solver (pruning, certified bounds or exhaustive proofs, memoization, fixed-matrix factor reuse), keyed by full inputs/policy/poll model with CPU/memory budgets and pending on exhaustion.
- [ ] **Computational limitation:** exact weekly classifications across a full early-season FBS schedule and all permitted poll orders are not implemented or benchmarked. Naive enumeration is exponential and cannot justify a mathematical label; this remains a gating product gap until certified and benchmarked at target scale.
- [ ] Offline fixtures for every label, shared-game consistency, polls, recovery from current .750 failure, four-label exception and timeout; realistic workload benchmarks.

## 5. Durable daily updates and delivery

- [ ] Durable 00:00 `America/Chicago` scheduler outside Next.js, configurable timezone and DST handling, lease/unique-run key, crash recovery, retries, manual replay, quotas and run-health inspection.
- [ ] Validate and hash full active-season fetch before upsert; correct scores/schedules/classifications/polls, bounded historical reconciliation and dependent snapshot/scenario invalidation. Leave previous publication available on failure.
- [ ] Deployment on one durable shared SQLite writer/volume, WAL-safe backup/restore, cache invalidation and resumable background scenario workers.
- [ ] Pin compatible Bun/Next dependencies and lockfile; add migrate/backfill/sync/rebuild/scenario commands, typechecks, integration/browser tests and README with credentials, policies, timezone, data coverage and proof limitations.

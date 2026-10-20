# CHARS implementation checklist

`PROJECT.md` is the full product/policy specification. This checklist tracks implementation, not a claim of completion. Synthetic tests are not historical validation.

## 1. Pure model and playoff engine

- [x] FBS-only Colley matrix, deterministic indexing, Cholesky solver, residual checks, exact comparison fallback, season-scoped records and FCS eligibility accounting.
- [x] Exact .750 eligibility; .90 bids, minimum-four bids, .85 play-ins, eligible contemporaneous-poll top-ups, and original routes.
- [x] Clean head-to-head edges, full-FBS SCC suppression, deterministic two-boundary swaps, selected-team topological seeding and cycle fallback.
- [x] Odd play-in bye, high/low pairings, fixed winner slots, seeded elimination bracket and synthetic tests.
- [ ] Integrate with authenticated, season-scoped real inputs; verify historical seasons against source data. No real-season or final-publication guarantee comes from the pure engine alone.

## 2. Persistent inputs, snapshots and backfill

- [ ] **Schema constraint: do not replace or alter the existing SQLite schema/migrations without explicit approval.** `packages/chars-db/src/schema.ts` has only teams, conferences, team-seasons, regular games and poll releases/entries. It lacks snapshot/game revisions, application game classification and completion state, ingestion payloads, scenario jobs, sync runs and leases required by `PROJECT.md`. Under the no-schema constraint, durable audited snapshots, temporal correctness, durable scheduling and proofs cannot be delivered as specified. Design an additive, approved migration strategy or document a separately approved storage mechanism before claiming these complete.
- [ ] Validate live CFBD games, membership, calendar and poll schemas; server-only API key, authenticated fetch, canonical IDs/aliases, season-specific FBS/FCS membership and data provenance.
- [ ] Backfill 1998 through provider/calendar-derived current season, including schedules, FCS opponents, season-specific poll releases and coverage gaps; provide absent-key setup/error state and `.env.example`.
- [ ] Define pre-CCG freeze per season, completed-game and poll cutoffs, Week 0/partial-week calendar mapping, no later results/polls, CFP 2014+ or AP through 2013, provisional AP fallback, and completeness checks.
- [ ] Implement transactional migration/repository/revision and atomic snapshot publication with policy/model/source hashes, appropriate indexes, WAL/foreign keys/busy timeout, cache invalidation, stale vs incomplete indicators.

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

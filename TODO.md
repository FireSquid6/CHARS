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
- [ ] Offline schema fixtures and bearer-authenticated season adapters added in `packages/chars-db/src/cfbd.ts`; live CFBD schema/coverage verification and operator-reviewed aliases remain open. Unknown IDs/classifications fail closed.
- [ ] `data:backfill` supports a year/range with July–June timezone convention, schedules, season roster, polls and raw cache audit; provider-derived season detection and comprehensive real historical validation remain open. `.env.example` and keyless error added.
- [ ] Pre-CCG freeze requires an operator-verified calendar and complete classification; retrospective weekly builder isolates completed games by kickoff/week and polls by release/week, with provisional AP fallback and explicit gaps. Historical completion times, current partial weeks, comprehensive schedule coverage validation and provider-derived calendars remain unimplemented.
- [ ] Typed read-only bun:sqlite repository and content-addressed JSON artifacts with atomic manifest replacement, hashes and coverage/pending indicators are implemented in `packages/chars-db/src/`. SQLite revisions, transactional coordination with source writes, live cache invalidation and stale status remain open.

## 3. Website and bracket UI

- [x] Home list for 1998–dynamic July–June current season with setup/current/final/incomplete states and season links (calendar timezone configurable via `SYNC_TIMEZONE`).
- [x] Server-render published snapshots for the default verified final or latest, shareable `?week=` navigation, complete FBS ranking/search/all-teams table, boundaries, original routes, category swaps and short-field explanations. Legacy team schedule links remain available when SQLite is configured.
- [x] Accessible final bracket with alternatives/byes/fixed seeds and no logos or winner substitution; four weekly bubble filters show zero proved and explicitly pending/unproved until a scenario publisher exists.
- [ ] Browser/screen-reader integration tests and real-season coverage validation; offline publication/timezone tests and responsive/keyboard-friendly markup added. No proved weekly witnesses or team details are available yet (section 4).

## 4. Exact scenarios and status proofs — computational limitation

- [ ] Implement shared-game terminal completions with fixed known schedule, FCS record bounds, eligible-only all-poll-order model, win-out quantifiers and the four ordered statuses. Reuse the same selection/bracket engine; handle historical ties where permitted.
- [ ] Detect the four-label coverage exception; retain proofs, qualifying/failing and win-out witnesses, poll-dependent help, and explicit assumptions. Never mislabel an unproved case as eliminated or clinched.
- [ ] Build a sound resumable solver (pruning, certified bounds or exhaustive proofs, memoization, fixed-matrix factor reuse), keyed by full inputs/policy/poll model with CPU/memory budgets and pending on exhaustion.
- [ ] **Computational limitation:** exact weekly classifications across a full early-season FBS schedule and all permitted poll orders are not implemented or benchmarked. Naive enumeration is exponential and cannot justify a mathematical label; this remains a gating product gap until certified and benchmarked at target scale.
- [ ] Offline fixtures for every label, shared-game consistency, polls, recovery from current .750 failure, four-label exception and timeout; realistic workload benchmarks.

## 5. Durable daily updates and delivery

- [ ] Existing midnight systemd timer now has `data:schedule`; local-day keys, durable cache lease, bounded HTTP retries, manual retry/status and recent-season reconciliation added. Not DB-backed; stale lock/manual journal review and no automated catch-up plan beyond current day remain limitations.
- [ ] Validated fetch and transactional regular-game/poll upsert with raw/hash sidecars and postseason calendar evidence added; filesystem/SQLite publication cannot be atomic. Missing-source rows trigger coverage warnings, previous publication stays on failure. Fine-grained scenario invalidation remains open.
- [ ] WAL-consistent SQLite `db:backup` added; cache backup/restore remains operator procedure. No scenario worker or cross-store transaction in this branch.
- [ ] Pin compatible Bun/Next dependencies and lockfile; add migrate/backfill/sync/rebuild/scenario commands, typechecks, integration/browser tests and README with credentials, policies, timezone, data coverage and proof limitations.

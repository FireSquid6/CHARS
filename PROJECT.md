# Colley playoff website and algorithm: coding-agent handoff

## Objective and scope

Build a Next.js website in TypeScript, using Bun and SQLite, around a deterministic, auditable selection and seeding engine for a hypothetical FBS playoff. Calculate Colley ratings internally from stored game results. Apply AP/CFP top-ups, a regular-season winning-percentage floor, and clean head-to-head overrides across selection boundaries and in seeding.

Support every season from 1998 through the current season, including the ongoing season (2026 when this handoff was updated); derive the current season dynamically, not from a hardcoded end year. Add older seasons only as a separately configured expansion. Implement the website, engine, persistent ingestion, daily job, structured results, and tests. Website brackets are in scope; PDF/booklet generation is not a deliverable. Do not use team logos anywhere.

This Markdown file is the complete handoff to an agent starting in a fresh workspace. No source code, database, data exports, reports, prior conversations, or other attachments will be supplied. Scaffold the project and acquire inputs from the documented API. The only required external credential is a valid CFBD API key supplied by the operator; implement a clear setup/error state when it is absent.

## Website product requirements

| Route/view | Required behavior |
| --- | --- |
| `/` | List every supported season, newest first, including the current one even before its first game. Each season links to its own page and shows preseason/current/final/data-incomplete state. |
| `/seasons/[year]` | Default to the final selection snapshot for a finished selection season, or the latest computed snapshot for the current season. Show its full FBS rankings, playoff cutoffs, selection categories, and record/rating information. |
| `/seasons/[year]?week=[snapshotKey]` | A shareable historical weekly view. Controls at the top include a week selector, previous/next week, and return-to-latest/final. Preserve the selected week on refresh and browser back/forward. |
| Final season view | Show the hypothetical playoff bracket, including `Team A / Team B` play-in alternatives, pairing/byes, and seeds. Do not fill hypothetical games with real-world postseason winners. |
| Non-final weekly view | Show the four status bubbles defined below: Eliminated, Needs help, Controls destiny, Clinched. Include counts and clickable filters, plus a status badge on each team row. |

The final selection snapshot freezes before CCG week according to the selection calendar below; it is not the rating after bowls. Once that snapshot is complete, the hypothetical bracket can be shown even while the real-world postseason is still in progress. Earlier weeks of a completed historical season still show the weekly status interface.

Show raw computed Colley rank, adjusted selected-team rank where applicable, rating, record, percentage, bid/play-in/outside status, initial selection route, and explanations of swaps or exclusion. Display .90 and .85 rating boundaries, minimum-four additions, and poll additions explicitly. Head-to-head swaps can put a team across a selection boundary without changing its rating; therefore the final field must be shown by category, not represented as a single horizontal rating cutoff. Support search and an all-teams view that includes ineligible teams.

Use text names, abbreviations, seed badges, and neutral geometric elements. No team logos, crest images, logo URLs, or external team-image requests, including in loading states or previews. Status colors must have text labels; support keyboard controls, semantic tables, narrow screens, and a bracket layout with accessible round/matchup labels.

Distinguish **current/provisional selection** from **end-of-season mathematical status**. Applying .750 to this week's record can exclude a team from today's provisional field; it does not prove the team cannot finish at .750. Before any games, ratings can be .500 but selection is empty because zero-game records are ineligible; status analysis still considers the remaining schedule.

## Technical architecture

- Next.js App Router, strict TypeScript, Bun as package manager/runtime/test runner, a committed Bun lockfile, and pinned compatible stable dependency versions. Use double quotes in TypeScript.
- Server-render season lists and ranking data. Use client components for week controls, filters, and interactive bracket details. Keep data access and credentials server-only.
- Use SQLite through `bun:sqlite` behind a typed repository layer, SQL migrations, foreign keys, prepared statements, transactions, WAL, and a configurable busy timeout. An ORM is optional, not required.
- Run Next.js and the scheduled worker on a persistent Bun-capable host/container with durable storage for the SQLite database. Keep computation outside request rendering; do not assume an ephemeral serverless filesystem is durable or that an Edge runtime provides Bun APIs.
- The web process and worker share one database on the same host/volume. Begin with one writer and bounded readers. Do not run independent writable SQLite copies behind multiple application replicas.
- Separate pure modules for `colley`, `eligibility`, `selection`, `head-to-head`, `seeding`, `brackets`, and `scenarios`, with separate CFBD adapters, repositories, jobs, and UI components. A scenario must invoke the same selection engine used by a real snapshot.
- Publish a completed snapshot and its results atomically; readers must not see half-rebuilt rankings. Cache by snapshot/data/policy/model revision and invalidate affected season views after publication. Show last successful sync and stale/pending/incomplete states separately from team status.
- Provide commands equivalent to `bun run db:migrate`, `bun run data:backfill --from 1998 --to CURRENT`, `bun run data:sync`, `bun run snapshots:rebuild --season YEAR`, `bun run scenarios:solve --snapshot KEY`, `bun test`, and the Next.js development/build/start scripts.

These are application deployment requirements. Implement the daily job in the deployed project; do not create a ChatGPT reminder or automation as a substitute.

## CollegeFootballData ingestion and daily job

Use [CFBD getting started](https://api.collegefootballdata.com/getting-started), the [games reference](https://api.collegefootballdata.com/api/games), and the [rankings reference](https://api.collegefootballdata.com/api/rankings). Store the API key in a server-side `CFBD_API_KEY` environment variable and send bearer authentication. Do not expose it through `NEXT_PUBLIC_*`, client code, URLs, or logs.

Use season-wide `/games?year=YEAR` queries with explicit season-type/classification parameters as appropriate, plus season-specific team membership and poll data. Validate the current response schema in the adapter rather than copying assumed field names. Store schedules as well as completed results: future fixtures are necessary for status proofs. Avoid filtering out games against FCS opponents during ingestion. Keep provider season type separate from the application's explicit CCG/bowl/regular classification; a provider's `regular` tag alone is not the selection rule.

1. Backfill historical seasons and current-season schedules, results, FBS membership, polls, and week calendars into SQLite. Historical membership must use that season's classification, not today's FBS list.
2. At **00:00 every day in `America/Chicago`**, launch a durable scheduler job. Store timestamps in UTC; configure the scheduler with the IANA timezone rather than a fixed UTC offset. Make timezone configurable while keeping this default explicit.
3. Fetch the complete active-season schedule/results and polls, including unresolved older games. Upsert by stable provider game ID: add new games, update final scores/completion flags, reschedules and cancellations, and corrected results. This is not an append-only importer. Reconcile recent completed seasons on a lower-frequency pass to catch corrections without re-downloading every historical year daily.
4. Validate the response before committing. Record raw payload/hash, fetch time, source identity, inserts/updates, and failures. Do not infer cancellation from one missing row, overwrite valid data with an empty failed response, or record an unfinished 0–0 game as a tie.
5. Detect material changes and rebuild affected weekly snapshots from the earliest affected game/week onward; recompute their ratings, selections, brackets, and scenario work. A poll or classification correction can also invalidate snapshots. Do nothing expensive for an unchanged payload.
6. Use a database-backed lease/unique scheduled-run key to prevent overlapping writers and duplicate daily runs. Retry transient failures with bounded backoff, respect provider quotas, and keep the previous successful snapshot available on failure. A restarted worker must recover unfinished work. Recheck currently unfinished games on the next run; games ending after midnight are picked up later.
7. Publish successful revisions atomically and invalidate the relevant Next.js cache. Run heavy scenario work through a resumable background queue; a delayed scenario job must not prevent publishing validated rankings.

The scheduler must live outside the Next.js request lifecycle; no browser-triggered or process-local `setInterval` as the sole scheduler. Provide deployment configuration, a manual retry command, health/last-run inspection, and a SQLite-consistent backup/restore procedure that accounts for WAL. Do not hold a write transaction during network requests or long scenario searches.

CFBD documents varying historical coverage and corrections. Validate completeness per season; missing poll or schedule data is a data gap, not proof of elimination. Before CFP releases begin in a season, use the latest available AP poll for provisional weekly top-ups, label the fallback, and switch to CFP when the corresponding release is available. This early-season AP fallback is a new display-policy default; final 2014+ selection still uses the pre-CCG CFP release. Never use a later release just because an API parameter offers `latest` or `final`.

## SQLite data model

Implement migrations with at least these logical tables; equivalent normalization is acceptable.

| Table | Important fields and constraints |
| --- | --- |
| `seasons` | `year` PK, state, selection freeze, calendar policy, coverage/completeness metadata. |
| `teams`, `team_aliases`, `team_seasons` | Stable internal/provider IDs; unique alias mappings; season-scoped FBS/FCS classification and conference. No logo fields are needed. |
| `games` | Provider game ID unique, season/week, home/away IDs, kickoff UTC, nullable scores, completed/status, provider season type, application game type, classification provenance, first/last seen, payload hash. Check different opponents and valid score/completion combinations. |
| `game_revisions` / `ingestion_payloads` | Source payload or immutable reference, hash, observed time, and previous normalized values. Support score/schedule correction auditing. |
| `poll_releases`, `poll_entries` | Season, poll type, associated game-week, release/effective timestamp, source hash; release/team unique, rank and ties retained. Store actual entries even when the hypothetical voter rule rejects them. |
| `snapshots`, `snapshot_games` | Snapshot key, game cutoff and poll cutoff, partial/week-final/selection-final flag, revision, selected poll release, input hash, policy/model versions, coverage; explicit included-game IDs and result revisions. |
| `snapshot_rankings`, `selection_events`, `bracket_slots` | Snapshot/team unique; records, rating precision/error metadata, raw/adjusted ranks, eligibility, original route, final category; ordered swaps, pair alternatives and seeds. |
| `scenario_jobs`, `scenario_statuses`, `scenario_witnesses` | Snapshot/team/poll-model keys, pending/running/proved/unsupported state, proved label, assumptions, solver version, runtime/proof metadata, example qualifying/failing completions and help conditions. |
| `sync_runs`, `job_leases`, `schema_migrations` | Scheduled key/run ID, UTC start/end, success/failure and counts; exclusive lease/expiry; migration versions. |

Index games by `(season, week)`, `(season, application_game_type, completed)`, and both team/season combinations; index poll lookup and snapshots by season/cutoff and statuses by snapshot/team. Include revision/model/policy identity in derived-result uniqueness. Store raw source revisions without fabricating historical knowledge: a retrospective weekly reconstruction uses results known by that game cutoff, but is not necessarily an archive of what the API itself reported on that date.

## Calculate Colley ratings internally

The website's authoritative `colleyRating` and `colleyRank` are computed from normalized included games. Do not scrape published Colley tables as runtime inputs or scenario shortcuts. Do not use CFBD's Elo/SRS/SP ratings as Colley inputs.

For a declared rating universe, let `n_i` count included games, `n_ij` count meetings, and `w_i`, `l_i` count decisive wins/losses within that same universe. Build and solve:

\[
C_{ii}=2+n_i,\qquad C_{ij}=-n_{ij}\ (i\ne j),\qquad
b_i=1+\frac{w_i-l_i}{2},\qquad Cr=b.
\]

Ties contribute to game counts and matrix entries but not to `w_i-l_i`. Repeated meetings count separately. Use outcomes only: no margin of victory, venue adjustment, preseason ranking, or conference weight. Include all teams in the chosen universe even if they fail playoff eligibility; eligibility is a downstream filter.

**Declared model default:** use all season-specific FBS teams as matrix vertices and completed FBS-versus-FBS games as matrix games, following the FBS-only formulation in Colley's original paper. FCS wins still count toward .750 eligibility, as specified below, but do not enter this model's matrix. Colley's published site also documents an FCS-group extension; exact reproduction would require a separately implemented and versioned grouping policy. Do not claim this default reproduces the published grouped rankings. Changing FCS treatment is a model change, not a numerical fix. Keep the .90/.85 thresholds; do not rescale computed ratings to match an external table.

Use a tested symmetric positive-definite linear solver, such as Cholesky, with deterministic team indexing. Do not explicitly invert a matrix for each snapshot. Retain full precision, check residuals, and use verified higher-precision/rational or interval fallback near .90, .85, or rank ties. Never use display rounding or an arbitrary epsilon to grant a bid. Use stable team ID to break a mathematically exact rating tie; published rank is no longer a tiebreaker.

Reference fixtures: no games gives every team .500; one game with A beating B gives A .625 and B .375; a symmetric three-team win cycle gives each .500. Check matrix symmetry, consistent row sums, residual, and mean rating .500 for the full modeled universe. These are solver fixtures, not assertions about only eligible teams.

## Weekly status semantics and exact scenario engine

For status labels, **qualifies** means ends up with a direct bid or a play-in invitation/bye at the final selection snapshot, before hypothetical play-ins are played. It does not mean winning a play-in or reaching a particular round. A direct-bid guarantee is stronger than required for Clinched.

At a selected non-final snapshot, freeze all completed included results. Let `Omega` contain every allowed completion of the known remaining pre-freeze regular-season schedule, together with the permitted terminal poll selections. Each game has one shared result, not independent per-team records. Modern future games have two decisive outcomes; handle possible ties only for historical rulesets where ties were allowed. Exclude future CCGs, bowls, and playoff games. Assume no future cancellation or newly added game unless explicitly modeled; label this fixed-schedule assumption and invalidate proofs when the schedule changes.

For each completion `s`, recompute terminal records/eligibility, Colley, initial selections, cycle handling, swaps, and seeds using the exact same engine. Define `Q(t,s)` to mean team t qualifies, and `W_t` as completions where t wins all its remaining included games. With no remaining games, winning out is vacuously satisfied.

| Bubble | Exact condition; evaluate in this order |
| --- | --- |
| **Clinched** | `Q(t,s)` is true for every `s` in `Omega`, even if t loses its remaining games. |
| **Eliminated** | No `s` in `Omega` has `Q(t,s)` true. |
| **Controls destiny** | Not already clinched, and `Q(t,s)` is true for every `s` in `W_t`: winning out guarantees at least a play-in regardless of other allowed results/poll selections. |
| **Needs help** | Not clinched, and there is both a qualifying and a nonqualifying completion in `W_t`: winning out can work but is insufficient by itself. |

Current .750 failure, an unfavorable current rating, or not appearing in a poll is not an elimination proof. Finishing below .750 even after winning out is an elimination proof. Compute record bounds exactly, using the complete included regular-season schedule and FCS outcomes for eligibility.

### Future polls and the voter eligibility rule

**It is illegal for hypothetical voters to vote a team below final .750 into this playoff field.** An 8–4 team cannot be a poll addition. This is not an exception for an attractive record or a way to force twelve participants. Preserve actual historical polls in storage but skip their ineligible entries for hypothetical selection; never rewrite the source poll. The final field can contain fewer than twelve teams.

Game results alone do not determine future AP/CFP rankings. Use this explicit, conservative default for mathematical status: quantify over every permitted ordering/subset of terminal **eligible** teams for the applicable poll, with up to 25 distinct teams, filled to `min(25, eligibleTeamCount)` for the scenario model. This models the adapted eligible-voter rule, not a prediction of actual voters. Poll top-ups cannot introduce an ineligible team. Real published releases can still contain ineligible teams; filtering them at a realized snapshot can leave fewer available entries than this future-poll model assumed. Record that distinction and scope every proof to its declared poll model.

Show `all eligible poll orders` with each result. Offer a separate frozen-current-poll or explicit-user-poll scenario only if labeled conditional; its labels are not unconditional mathematical claims. Do not use hindsight final polls in earlier-week proofs. If a Needs help path depends on voter choices rather than identifiable game results, say **poll-dependent** and show the required eligible poll condition; do not invent a statement that a particular team's win alone guarantees selection.

### Proofs, explanations, and computational limits

Find or rule out witnesses for: any qualifying completion, any failing completion, a qualifying win-out completion, and a failing win-out completion. Clinched/Eliminated/Controls destiny require an exhaustive proof or sound bounds/solver certificate; Monte Carlo results, sampled schedules, or a timeout cannot establish them.

Store qualifying and failing witnesses and let a team detail panel show one possible path, required wins, and poll assumptions. If displaying a compact help condition such as “win out AND B beats C,” verify its claimed sufficiency over all unspecified allowed outcomes. Label a witness “one possible path,” not a necessary or sufficient condition for every scenario unless proved. Support alternative paths and avoid representing an OR of paths as one AND list.

There is a potential four-label coverage issue: head-to-head swaps, cycles, and voter behavior have not been proved monotone in a team's own wins. If a qualifying completion exists but no qualifying win-out completion exists, none of the four user definitions applies. Detect this explicitly as a policy/model exception for review; do not falsely call the team Eliminated or silently redefine Needs help. A pending, incomplete, or unsupported computation is a data/computation state, not a fifth playoff status. Show the four bubbles while clearly disclosing any teams not yet proved/classifiable, rather than forcing every team into a false label.

Avoid naive full enumeration for an entire early season. Use exact record pruning, sound interval bounds on ratings and selection, branch-and-bound, constraint solving, memoized shared states, and cached witnesses. For a fixed remaining FBS schedule, the terminal Colley matrix is constant and its right-hand side varies with outcomes: reuse its factorization and derive outcome coefficients/bounds. Account for correlated opponent outcomes, changing head-to-head SCCs, and uncertain poll top-ups; a bound on one rating alone is not a full selection proof. Solve in Bun workers/background jobs and cache by complete input/schedule/policy/poll-model hash.

Set explicit CPU/memory budgets and persist resumable work. A budget exhaustion yields pending/unproved, never a guessed mathematical label. Benchmark exact small fixtures against exhaustive enumeration and the target historical/current weekly scope against realistic schedules. Do not declare the feature complete if the intended weekly classifications cannot be computed; report the remaining computational/policy limitation.

## Website and infrastructure acceptance tests

- Home includes every configured year through the current season, with working season links, preseason handling, and no hardcoded 2025 endpoint.
- Default completed-season view is the pre-CCG final snapshot and bracket; current-season view is the latest validated snapshot. Week controls are at the top and URL/history state works.
- Non-final views, including historical weeks, show four named bubbles with counts/filtering, per-team status details, and distinct computation/data states. Final views show final selections rather than future-status claims.
- Rating/selection boundaries, .750 exclusions, head-to-head explanations, and shortened fields are visible. A poll containing an 8–4 team cannot admit that team, including when the field otherwise stays below twelve.
- No team-logo files, imported logo components, logo URLs, or external image requests appear in rendered pages.
- All ratings are computed internally; numerical fixtures and exact threshold tests pass. Reordering ingested games or teams does not change results.
- The midnight scheduler uses `America/Chicago`, including offset changes, runs without site traffic, recovers after restart, prevents overlap, and supports manual replay. Repeating an ingestion payload does not duplicate games.
- Correcting a score, moving a kickoff/week, changing classification, receiving a late completion, or correcting a poll invalidates exactly the dependent revisions; failure leaves a coherent prior snapshot available.
- Weekly reconstruction cannot read later completed results or a later poll. Early-season AP fallback and poll publication timing are explicit. Missing data never appears as a proved Eliminated label.
- Small scenario fixtures cover each quantified label, poll-dependent qualification, an ineligible current record that can recover, win-out insufficiency, the four-label coverage exception, shared-game consistency, and solver timeout.
- Browser assets contain no API key. Public requests use SQLite/computed outputs, not fresh CFBD fetches or exponential scenario searches. Test migrations, transaction atomicity, backup/restore, responsive layout, and keyboard interactions.

## Source references and decisions to retain

Documentation checked October 19, 2026. The implementation agent must validate the live API schema and pin compatible dependency versions at build time.

- [CFBD getting started](https://api.collegefootballdata.com/getting-started), [games](https://api.collegefootballdata.com/api/games), [rankings](https://api.collegefootballdata.com/api/rankings), [availability](https://api.collegefootballdata.com/data-availability), and [usage/access](https://api.collegefootballdata.com/usage-and-access).
- [Colley's original matrix-method paper](https://www.colleyrankings.com/matrate.pdf) and [FCS-group extension](https://colleyrankings.com/iaagroups.html). The selected FBS-only default and published grouped rankings are different model configurations.
- [Next.js with Bun](https://bun.sh/guides/ecosystem/nextjs), [Bun SQLite](https://bun.sh/docs/runtime/sqlite), and [Next.js self-hosting](https://nextjs.org/docs/app/guides/self-hosting).

Keep policy defaults visible: cycle scope, outsider admission path, FCS rating treatment, odd play-in byes, fixed winner slots, and future-poll/scenario assumptions. All selection and seeding rules are specified in the following sections.

## Required behavior

1. Only teams with a regular-season winning percentage **≥ .750** may receive a direct bid, enter a play-in, or enter through a head-to-head swap. This percentage replaces the proposed literal nine-win requirement, including in COVID seasons.
2. Select every eligible team with Colley rating **≥ .90** for an initial direct bid. If fewer than four qualify, add the highest remaining eligible Colley teams until there are four or no eligible teams remain.
3. Select every remaining eligible team with Colley rating **≥ .85** for an initial play-in invitation.
4. If the combined field has fewer than twelve teams, add the highest-ranked remaining eligible teams from the contemporaneous CFP rankings, or AP poll in years before the CFP existed. Stop at twelve or when the published poll is exhausted. Twelve is a target, not a cap.
5. A clean head-to-head winner must be able to replace a losing direct-bid team from the play-in pool. The displaced team moves into the play-in pool.
6. An eligible team outside the field that has a clean head-to-head win over a play-in team must be able to replace that team in the play-in pool. The displaced team leaves the field.
7. Resolve chains of qualifying swaps, rather than performing only one pass.
8. Head-to-head cycles fall back to Colley instead of producing contradictory swaps or seeding. This includes three-team and four-team cycles.
9. Seed and pair teams using the resulting head-to-head-adjusted Colley order. Pair the highest play-in team against the lowest, second highest against second lowest, and so on.
10. Never waive eligibility to reach four bids, twelve participants, or an even play-in pool. Fields smaller than twelve are valid.
11. Hypothetical voters cannot select a team below .750. In particular, an 8–4 team is never a legal poll addition, even if excluding it leaves fewer than twelve participants.

## Implementation defaults requiring explicit documentation

The user specified the rules above but did not fully specify the interactions below. Use these defaults for a complete implementation; keep them visible in configuration and result metadata rather than presenting them as previously approved rules.

| Question | Default for this implementation |
| --- | --- |
| What is a clean head-to-head? | A won at least one included game against B, B won none against A, and there was no tie between them. Split series and tied series create no override. |
| Which cycles count? | Any directed cycle length. Use strongly connected components (SCCs), including larger or overlapping cycles. |
| Which teams participate in cycle detection? | All individual FBS teams in that season, including teams below .750. Eligibility filters selection, not the historical existence of a cycle. |
| What does cycle fallback change? | Suppress head-to-head overrides between members of the same cyclic SCC. Colley determines their relative seeding. Cycle membership alone does not grant a selection swap or a bid. |
| Can an outsider replace a direct bid immediately? | No. The explicit admission path is outsider → play-in → direct bid, with an actual clean win required at each boundary crossed. |
| Can several outsiders claim one slot? | Apply the deterministic swap procedure below, then recompute claims. Do not select based on data iteration order. |
| What happens to a displaced team? | It takes the other team's former selection category. Swaps preserve category sizes. |
| Does ≥ .90 remain an unconditional final bid? | No. It establishes the initial bid; head-to-head swaps can demote that team. |
| Is nine wins an additional floor? | No. Only ≥ .750 is required. Do not introduce a separate minimum-games requirement. |
| How are historical ties counted? | A tie contributes half a win in winning percentage. |
| Can the system add an unranked team just to reach twelve? | No. An unranked eligible team can enter through rating selection or a qualifying head-to-head swap, but there is no extra Colley top-up after the poll is exhausted. |
| What if there are an odd number of play-in teams? | Give the highest adjusted-ranked play-in team a bye. Do not add another team solely for parity. |
| What about postseason bans and conference champions? | No separate real-world postseason-ban filter or automatic conference-champion bid. |

These defaults are policy choices. Do not silently substitute a different interpretation while coding.

## Data timing and eligibility

Build a sequence of declared weekly snapshots per season, plus a current partial-week snapshot where needed. The terminal selection snapshot freezes before the first FBS conference championship game. For every snapshot, record the included completed-game set, game cutoff, associated poll release and poll cutoff. Source game-week and poll-week numbers are not guaranteed to describe the same interval; map them explicitly.

Exclude conference championship games, bowls, and playoff games. Use the poll release following the chosen regular-season weekend and before championship games; CFP from 2014 onward, AP through 2013. Do not use the final post-CCG CFP rankings for selection.

**Selection-calendar default:** freeze after the last full regular-season weekend before the first FBS conference championship game. Exclude late regular-season games during championship week as well as CCGs themselves. This allows the hypothetical play-ins to occupy CCG week. Configure and disclose the per-season cutoff rather than assuming a universal week number. A mode including later regular-season finales is a different calendar policy and must not be mixed into this default.

Use CFBD calendar data where available, deriving and validating older calendars from games when necessary. Week controls must represent the actual calendar, including Week 0, postponements, partial weeks and a final-selection option. Include only completed games belonging to the chosen snapshot, never later results or scheduled-game placeholder scores. A poll associated with those results may be released later; store its release/cutoff separately and ensure the snapshot does not read beyond that declared publication window. If exact historical completion/release timestamps are unavailable, document the weekly reconstruction convention rather than inventing timestamps.

For included games, calculate:

\[
\operatorname{winPct}(t)=\frac{W_t+\tfrac12T_t}{W_t+L_t+T_t}.
\]

A team with no included games is ineligible. Use exact arithmetic: for a nonempty record, eligibility is equivalent to `4 * wins + 2 * ties >= 3 * gamesPlayed`. Cancellations are not games. Count included regular-season wins against FCS opponents toward the record; FCS teams are not playoff candidates or FBS head-to-head graph vertices.

Examples: 9–3 qualifies; 8–3 does not; 6–2 and 3–1 qualify. A 9–4 team does not qualify despite having nine wins. This is a percentage rule in every season, not an exception only for 2020.

Compute Colley ratings internally as specified above; preserve solver precision before display rounding. Never compute Colley using only eligible teams. Ineligible FBS teams and included FBS games still contribute to the matrix.

## Inputs and identity

At minimum, supply:

- Season, cutoff, source URLs/releases, and an explicit game-inclusion convention.
- All FBS team IDs, display names, computed Colley rank, and unrounded internally calculated rating with model/precision metadata.
- Included regular-season games with stable game ID, date, team IDs, result, and game type. Preserve individual opponent identities; an aggregate FCS row cannot establish head-to-head results.
- Per-team snapshot records, reconciled against included games.
- Contemporaneous AP/CFP positions, including ties and unranked teams.

Use stable IDs internally, with explicit aliases for names such as USC/Southern California and Miami (FL)/Miami (OH). Never join on an ambiguous shortened name. Missing head-to-head data means unknown, not a confirmed absence of a game. Reject an incomplete season or mark the result incomplete; do not publish an apparently final result from a partial schedule.

Define a deterministic `colleyKey` as computed rating descending, then stable team ID ascending for a verified exact tie. Use it to break tied poll positions as well. Preserve raw computed Colley rank independently of adjusted rank and playoff seed. Resolve numerically ambiguous comparisons before applying this key.

## Stage 1: initial selection

```text
eligible = all FBS teams with winPct >= .750, ordered by colleyKey

bid = all eligible teams with rating >= .90
while size(bid) < 4 and an eligible unselected team remains:
    add the next team by colleyKey to bid

playin = all eligible teams outside bid with rating >= .85

for team in the chosen published poll, ordered by poll rank then colleyKey:
    if size(bid) + size(playin) >= 12:
        break
    if team is eligible and outside both sets:
        add team to playin
```

The rating stages are not capped at twelve. There is no fallback to an ineligible team. A short field after the poll top-up remains short. Do not revisit rating thresholds or top-up selection after head-to-head swaps; that would undo swaps or inflate the field.

Keep each team's original route: `rating_bid`, `colley_minimum_bid`, `rating_playin`, `poll_playin`, or `outside`.

## Stage 2: head-to-head graph and cycles

Construct the raw graph once, from included games among all FBS teams. Add `A → B` only for a clean head-to-head win by A over B. Repeated wins in the same direction produce one edge. A split or tied series produces no edge.

Find the raw graph's SCCs using Tarjan's or Kosaraju's algorithm. Every SCC with more than one member is cyclic. Suppress every edge whose endpoints are in that same cyclic SCC. Retain edges crossing between SCCs. Do not suppress an entire season or an external win merely because one endpoint participates in a cycle.

This is deliberately broader than checking only three- and four-team loops: a season can have a large SCC connected by longer chains, so this default can suppress many head-to-head overrides. If the intended exception is limited strictly to cycles of length three or four, change the policy explicitly and replace SCC-wide suppression with bounded-cycle edge detection; the two interpretations are not equivalent.

Call the remaining graph `activeH2H`. It is a DAG. Compute SCC membership once for the full season, before selection swaps, and reuse it throughout. Do not detect cycles only among the initially selected teams or only in a local triangle.

Important distinction: A beats B and B beats C does **not** create an invented A-over-C win. Reachability detects cycles and implies ordering constraints; it does not authorize an admission or bid swap without an actual active head-to-head edge between the teams being exchanged.

## Stage 3: selection-category swaps

Use a full ordered list of eligible teams, initialized as three contiguous sections:

```text
L = sortColley(initialBid)
  + sortColley(initialPlayin)
  + sortColley(eligibleOutsideField)

D = size(initialBid)
P = size(initialPlayin)
```

Positions `[0, D)` are bids; `[D, D + P)` are play-ins; the rest are outside. Section sizes remain fixed. The positions within these sections are working state, not the final seeds.

An active edge `winner → loser` permits a swap only if:

- Winner is currently in `playin` and loser is currently in `bid`; or
- Winner is currently `outside` and loser is currently in `playin`.

Both endpoints must be eligible. No transitive replacement claims, direct outsider-to-bid exchanges, or unrelated expulsions are allowed.

Repeatedly enumerate permitted swaps. Choose one by this deterministic priority:

1. Play-in-to-bid swaps before outsider-to-play-in swaps.
2. Earliest current loser position in `L`.
3. Best winner `colleyKey`, then stable loser ID.

Exchange those two exact positions, append an audit event, and recompute allowed swaps. Stop only when none remain. Do not re-sort the list or refill categories between exchanges. A newly admitted team may subsequently take a bid; a displaced bid team may subsequently lose its play-in place.

This procedure terminates: any topological order of `activeH2H`, restricted to eligible teams, supplies a reference permutation. Every permitted exchange corrects an inversion in that reference order and strictly reduces its inversion count. Do not implement an arbitrary iteration limit as the selection rule; a repeated state indicates a bug.

At completion, a direct-only win by an outsider can remain unapplied if that outsider never earns a play-in place. Report that case as an unapplied claim under the explicit boundary rule, not as a data error or an invented admission entitlement.

## Stage 4: adjusted seeding order

Membership and category assignment are now frozen. Order all selected teams together; retain their category labels.

Construct a seeding DAG with:

- Every `activeH2H` edge whose endpoints are both selected.
- For selected members of each original cyclic SCC, a chain in `colleyKey` order. This enforces the Colley fallback inside that cycle group without inventing head-to-head wins.

Perform a topological sort, always taking the best `colleyKey` among currently available zero-indegree teams. This yields one deterministic order that respects every applicable head-to-head constraint and the cycle fallback. A head-to-head flip means the winner precedes the loser; other teams can move as necessary to satisfy a chain of results.

Do not use an ordinary sorting comparator that sometimes compares Colley ratings and sometimes compares game results. That comparator can violate transitivity even when no three-team head-to-head cycle exists.

Report the new `adjustedRank` alongside, never instead of, the original `colleyRank`. A selection swap changes the category; seeding alone must not silently reassign bids.

## Stage 5: play-in pairing and main bracket

1. Sort the final play-in pool by `adjustedRank`.
2. If its size is odd, remove its highest-ranked team and give it a play-in bye.
3. Pair the remaining first versus last, second versus second-last, and so on.
4. Create main-bracket slots for every direct bid, every play-in winner, and any play-in bye recipient.
5. A pair's provisional slot priority is its higher adjusted-ranked member. A singleton uses its own adjusted rank. Sort those priorities and assign consecutive main-bracket seeds.
6. Display unresolved play-in slots as `Team A / Team B`. Do not predict winners.
7. Use fixed slots: a play-in winner inherits its pair's slot, with no reseeding. This guarantees the specified pre-play-in ordering; it cannot guarantee that every lower-ranked upset winner receives the seed it would receive in a fresh team-by-team ranking. Dynamic reseeding would be a separate policy change.
8. Build a conventional seeded elimination bracket, with highest seeds receiving any necessary byes. Handle fields above or below eight, empty play-in pools, and fields below four. No automatic invitations for bracket convenience.

With a play-in bye, main-bracket size is `D + ceil(P / 2)`. For an even play-in pool it is `D + P / 2`. Pairing and slot seeding use adjusted rank; original Colley ratings remain visible as source information.

For `N > 1` main-bracket slots, expand to the smallest power-of-two bracket size `B >= N`, with absent seeds treated as byes. Generate standard seed positions starting from `[1, 2]`; for each doubled size `b`, replace every prior seed `s` with `[s, b + 1 - s]`. At size eight this gives `[1, 8, 4, 5, 2, 7, 3, 6]`. Pair adjacent positions and advance byes without playing a game. A one-team field is represented without a fabricated matchup; an empty field has no bracket.

## Outputs and auditability

Return structured JSON per season with:

- Snapshot metadata, policy version/defaults, completeness status, and source references.
- All eligible and excluded teams, records, exact percentage numerator/denominator, ratings, and eligibility reasons.
- Initial and final `bid`/`playin` sets and original selection routes.
- Raw clean head-to-head edges, suppressed cyclic edges, SCC membership, and the game IDs supporting each edge.
- Ordered swap events with before/after categories, winner, loser, supporting games, and iteration number.
- Unapplied outsider-to-direct-only claims, if any.
- Adjusted team order, play-in pairings/byes, and seeded main-bracket slots with unresolved team alternatives.
- Counts and a concise before/after explanation, including why the field is short when applicable.

Keep source selection route separate from final status. A poll-selected team promoted to a bid remains identifiable as originally poll-selected. Likewise, a rating-bid team demoted into a play-in must not be relabeled as an original play-in selection.

## Acceptance tests

Use synthetic fixtures first; historical records are integration tests, not substitutes for edge-case coverage.

| Fixture | Required result |
| --- | --- |
| Exact eligibility boundary | 9–3, 6–2, and 3–1 qualify; 8–3 and 9–4 do not. No-games record fails. |
| Eligibility beats every selection route | An ineligible team cannot enter via rating, minimum-bid fill, poll fill, head-to-head, or parity. |
| Exact rating boundaries | A computed rating exactly .90 triggers an initial bid; exactly .85 triggers a rating play-in if not a bid. Solver/display rounding cannot change membership. |
| Ineligible poll entries | Skip them and continue down the published poll; leave the field short if it is exhausted. |
| Rating field above twelve | Preserve all qualifying initial selections. |
| Play-in beats bid | P has an active win over D: P receives the bid and D receives P's play-in place. |
| Outsider beats play-in | Eligible O has an active win over P: O replaces P without changing the participant count. |
| Two-stage admission | O beats P and O beats D: O can enter through P and then take D's bid. D becomes a play-in team; P leaves. |
| Direct-only outsider claim | O beats D but no current play-in opponent: no immediate admission. |
| Multiple claimants | Input shuffling produces identical swaps and final selections under the specified priority. |
| Chains | A beats B, B beats C, no cycle: selected teams seed A before B before C. No invented A-over-C membership claim. |
| Three-team cycle | A beats B, B beats C, C beats A: suppress internal overrides and order selected A/B/C by Colley. |
| Four-team cycle | A beats B, B beats C, C beats D, D beats A: same fallback, even without a triangle. |
| Overlapping cycles | Use the full SCC, not independently applied local cycle exceptions. |
| Cycle with outside/ineligible member | Detect it before filtering the selection field; do not overlook the cycle. |
| External edge from a cyclic group | An edge between that group and another SCC remains active. |
| Split/tied season series | No clean override. Multiple wins in only one direction create one override. |
| No active head-to-head changes | Initial categories survive; adjusted seeding reduces to Colley order. |
| Swap invariants | Bid/play-in counts are preserved; sets stay disjoint; every selected team is eligible; loop terminates. |
| Odd play-in pool | Highest adjusted-ranked invite gets the bye; all remaining teams appear in exactly one pair. |
| Fixed winner slots | Both alternatives share the pair's provisional seed; a lower-team win does not trigger reseeding. |
| Temporal isolation | Adding a CCG or bowl result to the raw source does not affect a result for the frozen snapshot. |
| Reproducibility | Identical source data and policy produce identical outputs, including audit order. |

Also validate the termination argument on generated small DAGs and validate that the final seeding order satisfies every seeding edge. A second run from the same original inputs must reproduce the output; do not feed a previous final field back into initial selection as an idempotence shortcut.

## Fresh-workspace implementation and delivery

Create the repository from this specification. A suggested structure is:

```text
app/page.tsx
app/seasons/[year]/page.tsx
components/
src/domain/{colley,eligibility,selection,head-to-head,seeding,brackets,scenarios}.ts
src/data/cfbd/
src/data/repositories/
src/jobs/
db/migrations/
scripts/
tests/fixtures/
deploy/
.env.example
README.md
```

Create `.env.example` with placeholders and documented defaults for `CFBD_API_KEY`, an absolute SQLite database path, `SYNC_TIMEZONE=America/Chicago`, `START_SEASON=1998`, and scenario computation budgets. Keep actual credentials and database files out of version control. Derive the current football season from provider calendar/season metadata and the configured football calendar, not a naive assumption that a January postseason belongs to the new calendar year's season.

Provide typed contracts for normalized games, polls, snapshot inputs, computed ratings, selection results, swap events, bracket slots and scenario proofs. Validate external data at the ingestion boundary; UI code should consume validated domain results. Include offline synthetic fixtures so the core test suite runs without an API key or network. These fixtures demonstrate correctness and must not be presented as real season results.

Implement in dependency order: project/migrations and source adapters; normalized backfill; Colley and selection engine; weekly snapshots and rankings UI; hypothetical bracket UI; exact scenario/status engine; scheduled ingestion/deployment. Make the mathematical status engine a tracked deliverable, not an unspecified enhancement. Clearly report a missing credential, coverage issue, unresolved model exception, or unproved status rather than substituting fabricated data or a heuristic label.

Deliver the Next.js/TypeScript/Bun project, SQLite migrations, reproducible CFBD backfill, persistent daily scheduler configuration, engine and browser tests, and a README covering local setup, API credentials, deployment, timezone, database backup/restore, policy defaults, and computational limits. Pin policy/model versions, retain source provenance, and expose Bun commands for one season or a range. No code, dataset, or other attachment beyond this Markdown file may be assumed.

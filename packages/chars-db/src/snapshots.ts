/** Offline snapshot reconstruction: observed corrections are retrospective, not historical API archives. */
import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { CALENDAR_POLICY_VERSION, MODEL_VERSION, POLICY_VERSION, computeColley, computeEligibility,
  computePlayoff, type Game, type TeamSeason } from "chars-algorithm";
import { configFromEnv, createRepository, openDatabase, transaction } from "./index";
import { migrate } from "./migrate";

type Week = { week: number; start_utc: string; end_utc: string; source_hash: string };
type GameRow = Game & { completed_at_utc: string | null; resultObservedUtc: string; classification_provenance_json: string };
type Poll = { id: string; poll_type: "ap" | "cfp"; game_week: number | null;
  effective_at_utc: string | null; released_at_utc: string | null; timing_provenance: string;
  source_hash: string; provider_season_type: string };
export type SnapshotPlan = { key: string; season: number; week: number | null;
  kind: "partial" | "week_final" | "selection_final"; gameCutoff: string; pollCutoff: string | null };
export type RebuildReport = { published: string[]; unchanged: string[]; incomplete: Array<{ key: string; reasons: string[] }> };
export type RebuildOptions = { beforePublish?: (plan: SnapshotPlan) => void };
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const rows = <T>(db: Database, sql: string, ...args: (string | number)[]): T[] => db.query(sql).all(...args) as T[];
const first = <T>(db: Database, sql: string, ...args: (string | number)[]): T | null => db.query(sql).get(...args) as T | null;

export function publishedSnapshot(db: Database, key: string) {
  return first<{ snapshot_key: string; revision: number; input_hash: string; kind: string }>(db,
    `SELECT s.snapshot_key, s.revision, s.input_hash, s.kind FROM snapshot_publications p
     JOIN snapshots s ON s.snapshot_key=p.snapshot_key AND s.revision=p.revision WHERE p.snapshot_key=?`, key);
}

/** Calendar windows are authoritative; unknown completion times are reconstructed at week end only. */
export function planSnapshots(db: Database, season: number, nowUtc = new Date().toISOString()): SnapshotPlan[] {
  const weeks = rows<Week>(db, `SELECT week, start_utc, end_utc, source_hash FROM season_calendar_weeks
    WHERE season=? AND season_type='regular' ORDER BY start_utc, week`, season);
  const freeze = (first<{ selection_freeze_utc: string | null }>(db,
    "SELECT selection_freeze_utc FROM season_ingestion_gaps WHERE season=? ORDER BY observed_at_utc DESC, rowid DESC LIMIT 1", season)
    ?? first<{ selection_freeze_utc: string | null }>(db,
      "SELECT selection_freeze_utc FROM seasons WHERE year=?", season))?.selection_freeze_utc;
  const ccg = first<{ kickoff_utc: string }>(db, `SELECT kickoff_utc FROM games WHERE season=?
    AND application_game_type='ccg' AND kickoff_utc IS NOT NULL ORDER BY kickoff_utc LIMIT 1`, season)?.kickoff_utc;
  const plans: SnapshotPlan[] = [{ key: `${season}:preseason`, season, week: null, kind: "partial",
    gameCutoff: weeks[0]?.start_utc ?? `${season}-07-01T00:00:00.000Z`, pollCutoff: null }];
  for (let i = 0; i < weeks.length; i++) {
    const week = weeks[i]!;
    if (week.end_utc > nowUtc || (freeze && week.end_utc > freeze) || (ccg && week.end_utc >= ccg)) break;
    const next = weeks[i + 1];
    const pollCutoff = next && next.start_utc > week.end_utc && (!ccg || next.start_utc < ccg)
      ? next.start_utc : ccg && ccg > week.end_utc ? ccg : null;
    plans.push({ key: `${season}:week:${week.week}`, season, week: week.week, kind: "week_final",
      gameCutoff: week.end_utc, pollCutoff });
  }
  if (freeze && ccg && freeze < ccg && freeze <= nowUtc) {
    const week = weeks.find(w => w.end_utc === freeze);
    if (week) plans.push({ key: `${season}:selection-final`, season, week: week.week,
      kind: "selection_final", gameCutoff: freeze, pollCutoff: ccg });
  }
  const active = weeks.find(w => w.start_utc <= nowUtc && w.end_utc > nowUtc &&
    (!freeze || w.start_utc <= freeze) && (!ccg || nowUtc < ccg));
  if (active) plans.push({ key: `${season}:week:${active.week}:partial`, season, week: active.week,
    kind: "partial", gameCutoff: nowUtc, pollCutoff: nowUtc });
  return plans;
}

function selectPoll(db: Database, plan: SnapshotPlan): Poll | null {
  if (plan.week === null || !plan.pollCutoff) return null;
  const releases = rows<Poll>(db, `SELECT id, poll_type, game_week, effective_at_utc, released_at_utc,
    timing_provenance, source_hash, provider_season_type FROM poll_releases
    WHERE season=? AND is_current=1 AND provider_season_type='regular' AND game_week IS NOT NULL
    AND (released_at_utc IS NOT NULL OR (effective_at_utc IS NOT NULL AND effective_at_utc <= ?))
    AND (released_at_utc IS NULL OR (released_at_utc > ? AND released_at_utc < ?))
    ORDER BY game_week DESC, effective_at_utc DESC, id`, plan.season, plan.pollCutoff,
    plan.kind === "partial" ? "0000-01-01T00:00:00.000Z" : plan.gameCutoff, plan.pollCutoff);
  // Never use a release for later games even if its effective timestamp was derived incorrectly.
  const eligible = releases.filter(p => p.game_week! <= plan.week! + 1 &&
    (p.released_at_utc !== null || p.timing_provenance === "derived_convention" ||
      (plan.kind !== "partial" && p.timing_provenance === "derived_pre_ccg_cutoff" &&
        p.effective_at_utc === plan.pollCutoff)));
  const desired = plan.season < 2014 ? "ap" : "cfp";
  // The final release must correspond to the completed weekend; no older fallback can certify selection.
  if (plan.kind === "selection_final") return eligible.find(p => p.poll_type === desired && p.game_week === plan.week! + 1) ?? null;
  return eligible.find(p => p.poll_type === desired) ??
    (plan.season >= 2014 ? eligible.find(p => p.poll_type === "ap") : null) ?? null;
}

function generation(db: Database, season: number): number {
  return first<{ generation: number }>(db,
    "SELECT generation FROM season_input_generations WHERE season=?", season)?.generation ?? 0;
}

function build(db: Database, plan: SnapshotPlan, nowUtc: string, expectedGeneration: number,
  options: RebuildOptions): { changed: boolean; reasons: string[] } {
  db.exec("BEGIN");
  let reading = true;
  const finishRead = () => { db.exec("COMMIT"); reading = false; };
  try {
    return buildConsistent(db, plan, nowUtc, expectedGeneration, options, finishRead);
  } catch (error) {
    if (reading) db.exec("ROLLBACK");
    throw error;
  }
}

function buildConsistent(db: Database, plan: SnapshotPlan, nowUtc: string, expectedGeneration: number,
  options: RebuildOptions, finishRead: () => void): { changed: boolean; reasons: string[] } {
  const readGeneration = generation(db, plan.season);
  if (readGeneration !== expectedGeneration) {
    finishRead();
    return { changed: false, reasons: ["source changed during rebuild; retry"] };
  }
  const season = createRepository(db).season(plan.season);
  if (!season) throw new Error(`Season ${plan.season} is not ingested`);
  const teams = rows<TeamSeason>(db, `SELECT season, team_id AS teamId, membership, conference
    FROM team_seasons WHERE season=? ORDER BY team_id`, plan.season);
  const weekRows = rows<Week>(db, `SELECT week, start_utc, end_utc, source_hash FROM season_calendar_weeks
    WHERE season=? AND season_type='regular' ORDER BY start_utc, week`, plan.season);
  const latestGap = first<{ coverage_json: string; selection_freeze_utc: string | null }>(db, `SELECT coverage_json, selection_freeze_utc FROM season_ingestion_gaps
    WHERE season=? ORDER BY observed_at_utc DESC, rowid DESC LIMIT 1`, plan.season);
  const coverage: Record<string, boolean> = JSON.parse(latestGap?.coverage_json ?? season.coverage);
  const reasons: string[] = [];
  if (!teams.some(t => t.membership === "fbs") || coverage.fbsRoster === false) reasons.push("missing FBS membership");
  if (!weekRows.length || coverage.calendar === false) reasons.push("missing calendar coverage");
  if (plan.kind === "selection_final") {
    for (const field of ["schedule", "gameClassification", "gameMembership", "gameStatusKnown", "selectionFreeze"])
      if (coverage[field] !== true) reasons.push(`unverified ${field}`);
    if ((latestGap?.selection_freeze_utc ?? season.selectionFreezeUtc) !== plan.gameCutoff) reasons.push("selection freeze mismatch");
    const firstCcg = first<{ kickoff_utc: string }>(db, `SELECT kickoff_utc FROM games WHERE season=?
      AND application_game_type='ccg' AND kickoff_utc IS NOT NULL ORDER BY kickoff_utc LIMIT 1`, plan.season);
    if (!firstCcg || firstCcg.kickoff_utc !== plan.pollCutoff)
      reasons.push("no independently classified first CCG");
    if (weekRows.some(w => w.end_utc > plan.gameCutoff && w.end_utc < (plan.pollCutoff ?? "")))
      reasons.push("selection freeze precedes another full regular week");
    for (let i = 1; i < weekRows.length; i++) {
      const prior = weekRows[i - 1]!, next = weekRows[i]!;
      if (next.start_utc < plan.gameCutoff && (next.week !== prior.week + 1 || next.start_utc <= prior.end_utc))
        reasons.push("irregular or missing weekly calendar");
    }
  }
  const games = rows<Omit<GameRow, "completed"> & { completed: number }>(db, `SELECT id, provider_game_id AS providerGameId, season, week,
    home_team_id AS homeTeamId, away_team_id AS awayTeamId, kickoff_utc AS kickoffUtc,
    home_score AS homeScore, away_score AS awayScore, status, completed,
    provider_season_type AS providerSeasonType, application_game_type AS applicationGameType,
    classification_source AS classificationSource, classification_provenance_json,
    completed_at_utc, g.payload_hash AS payloadHash, g.result_revision AS resultRevision,
    r.observed_at_utc AS resultObservedUtc
    FROM games g JOIN game_revisions r ON r.game_id=g.id AND r.revision=g.result_revision
    WHERE season=? AND kickoff_utc IS NOT NULL AND kickoff_utc<=? ORDER BY g.id`, plan.season, plan.gameCutoff)
    .map(game => ({ ...game, completed: game.completed === 1 }));
  const memberships = new Map(teams.map(t => [t.teamId, t.membership]));
  const week = new Map(weekRows.map(w => [w.week, w]));
  const included: GameRow[] = [];
  for (const game of games) {
    if (game.applicationGameType === "unknown") reasons.push(`unknown game classification ${game.id}`);
    if (game.applicationGameType !== "regular") continue;
    const window = game.week === null ? undefined : week.get(game.week);
    if (!window || !game.kickoffUtc || game.kickoffUtc < window.start_utc || game.kickoffUtc > window.end_utc) {
      reasons.push(`unmapped calendar game ${game.id}`); continue;
    }
    if (!memberships.has(game.homeTeamId) || !memberships.has(game.awayTeamId)) {
      reasons.push(`missing opponent membership ${game.id}`); continue;
    }
    if (plan.kind !== "partial" && game.status !== "cancelled" && !game.completed) {
      reasons.push(`unresolved scheduled game ${game.id}`);
    }
    if (!game.completed) continue;
    // A missing completion date is not permission to include an unfinished current-week game.
    const completion = game.completed_at_utc ?? (plan.kind === "partial" && game.resultObservedUtc <= plan.gameCutoff &&
      game.resultObservedUtc >= game.kickoffUtc ? game.resultObservedUtc : null);
    if (completion ? completion > plan.gameCutoff : window.end_utc > plan.gameCutoff) {
      if (plan.kind !== "partial") reasons.push(`result after game cutoff ${game.id}`);
      else if (!game.completed_at_utc) reasons.push(`unverified partial completion ${game.id}`);
      continue;
    }
    included.push(game);
  }
  const poll = selectPoll(db, plan);
  if (plan.kind === "selection_final" && !poll) reasons.push("missing corresponding pre-CCG poll release");
  if (plan.kind === "week_final" && !poll) reasons.push("missing contemporaneous poll release");
  const pollEntries = poll ? rows<{ teamId: string; rank: number | null }>(db,
    "SELECT team_id AS teamId, rank FROM poll_entries WHERE release_id=? ORDER BY rank, team_id", poll.id)
    .filter((entry): entry is { teamId: string; rank: number } => entry.rank !== null) : [];
  if (plan.kind === "selection_final" && !pollEntries.length) reasons.push("empty selection poll");
  const input = { season: plan.season, teams, games: included };
  const revisionRefs = included.map(g => [g.id, g.resultRevision, g.payloadHash]);
  const digest = hash({ plan, teams: teams.map(t => [t.teamId, t.membership]),
    calendar: weekRows.filter(w => w.end_utc <= plan.gameCutoff).map(w => [w.week, w.start_utc, w.end_utc, w.source_hash]),
    games: revisionRefs, poll: poll ? [poll.id, poll.source_hash, poll.effective_at_utc, poll.released_at_utc] : null,
    entries: pollEntries, coverage, reasons: [...new Set(reasons)].sort(),
    policy: POLICY_VERSION, model: MODEL_VERSION, calendarPolicy: CALENDAR_POLICY_VERSION });
  const existing = publishedSnapshot(db, plan.key);
  const invalidations = existing ? rows<{ reason: string }>(db, `SELECT reason FROM snapshot_input_invalidations
    WHERE snapshot_key=? AND snapshot_revision=?`, plan.key, existing.revision) : [];
  if (reasons.length && plan.kind === "selection_final") {
    finishRead();
    transaction(db, () => {
      if (generation(db, plan.season) === readGeneration) db.query(
        "UPDATE snapshot_publications SET state='stale' WHERE snapshot_key=?").run(plan.key);
    });
    return { changed: false, reasons: [...new Set(reasons)] };
  }
  // Weekly gaps are disclosed, never interpreted as a proved final or elimination.
  if (existing?.input_hash === digest) {
    finishRead();
    options.beforePublish?.(plan);
    transaction(db, () => {
      if (generation(db, plan.season) !== readGeneration) throw new StaleInputError();
      // Broad ingestion hints can cover later, irrelevant results; verified identical inputs do not need a revision.
      if (publishedSnapshot(db, plan.key)?.revision !== existing.revision) throw new Error("Concurrent publication");
      if (invalidations.length) db.query("DELETE FROM snapshot_input_invalidations WHERE snapshot_key=? AND snapshot_revision=?")
        .run(plan.key, existing.revision);
      db.query("UPDATE snapshot_publications SET state='current' WHERE snapshot_key=?").run(plan.key);
    });
    return { changed: false, reasons: [...new Set(reasons)] };
  }
  const ratings = computeColley(input);
  const records = [...computeEligibility(input)].map(([teamId, value]) => ({ teamId, record: value.record }));
  const revision = (first<{ revision: number }>(db,
    "SELECT MAX(revision) AS revision FROM snapshots WHERE snapshot_key=?", plan.key)?.revision ?? 0) + 1;
  const result = computePlayoff({ ...input, ratings, records, pollEntries }, {
    key: plan.key, season: plan.season, revision, inputHash: digest, policyVersion: POLICY_VERSION,
    modelVersion: MODEL_VERSION, calendarPolicyVersion: CALENDAR_POLICY_VERSION });
  finishRead();
  options.beforePublish?.(plan);
  transaction(db, () => {
    if (generation(db, plan.season) !== readGeneration) throw new StaleInputError();
    // Another publisher cannot interleave; the pointer changes only after every dependent row exists.
    const current = publishedSnapshot(db, plan.key);
    if (current?.revision !== existing?.revision) throw new Error(`Concurrent publication of ${plan.key}`);
    db.query(`INSERT INTO snapshots (snapshot_key, revision, season, week, kind, game_cutoff_utc,
      poll_cutoff_utc, poll_release_id, input_hash, policy_version, model_version,
      calendar_policy_version, coverage_json, published_at_utc) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(plan.key, revision, plan.season, plan.week, plan.kind, plan.gameCutoff, plan.pollCutoff, poll?.id ?? null,
        digest, POLICY_VERSION, MODEL_VERSION, CALENDAR_POLICY_VERSION,
        JSON.stringify({ complete: reasons.length === 0, reasons: [...new Set(reasons)],
          poll: poll ? { type: poll.poll_type, fallback: plan.season >= 2014 && poll.poll_type === "ap",
            timingProvenance: poll.timing_provenance, effectiveAtUtc: poll.effective_at_utc,
            releasedAtUtc: poll.released_at_utc } : null,
          gameConvention: "completion timestamp when supplied; otherwise reconstructed at calendar week end",
          retrospective: true }), nowUtc);
    for (const game of included) db.query(`INSERT INTO snapshot_games VALUES (?,?,?,?)`)
      .run(plan.key, revision, game.id, game.resultRevision);
    for (const ranking of result.seeding.rankings) db.query(`INSERT INTO snapshot_rankings
      (snapshot_key,snapshot_revision,team_id,wins,losses,ties,rating,residual,precision_method,
       colley_rank,adjusted_rank,eligible,eligibility_reason,original_route,final_category)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(plan.key, revision, ranking.teamId,
        ranking.record.wins, ranking.record.losses, ranking.record.ties, ranking.colleyRating,
        ranking.residual, ranking.precisionMethod, ranking.colleyRank, ranking.adjustedRank,
        Number(ranking.eligible), ranking.eligible ? null : ranking.record.percentageDenominator === 0 ? "no games" : "below .750",
        ranking.originalRoute, ranking.finalCategory);
    for (const event of result.seeding.swaps) db.query(`INSERT INTO selection_events VALUES (?,?,?,?,?,?,?)`)
      .run(plan.key, revision, event.sequence, "head_to_head_swap", event.winnerTeamId,
        event.loserTeamId, JSON.stringify(event));
    // Round zero records seeded play-in alternatives (or a singleton); later rounds retain source slot IDs.
    for (const slot of result.mainSlots) db.query(`INSERT INTO bracket_slots VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(plan.key, revision, 0, slot.seed - 1, slot.seed, slot.teamAId, slot.teamBId,
        slot.playinPairId, null, 0);
    for (const round of result.rounds) for (const match of round) db.query(`INSERT INTO bracket_slots VALUES (?,?,?,?,?,?,?,?,?,?)`)
      .run(plan.key, revision, match.round, match.position - 1, null, null, null,
        JSON.stringify(match.first), match.second ? JSON.stringify(match.second) : null, Number(match.isBye));
    db.query(`INSERT INTO snapshot_publications (snapshot_key, revision, published_at_utc, state) VALUES (?,?,?,'current')
      ON CONFLICT(snapshot_key) DO UPDATE SET revision=excluded.revision, published_at_utc=excluded.published_at_utc, state='current'`)
      .run(plan.key, revision, nowUtc);
    // Only clear invalidations for a successfully superseded published revision.
    if (existing) db.query(`DELETE FROM snapshot_input_invalidations WHERE snapshot_key=? AND snapshot_revision<=?`)
      .run(plan.key, existing.revision);
  });
  return { changed: true, reasons: [...new Set(reasons)] };
}

class StaleInputError extends Error {}

export function rebuildSnapshots(db: Database, season: number, nowUtc = new Date().toISOString(),
  options: RebuildOptions = {}): RebuildReport {
  if (!Number.isSafeInteger(season) || season < 1998 || !Number.isFinite(Date.parse(nowUtc)))
    throw new Error("Invalid season or UTC time");
  const report: RebuildReport = { published: [], unchanged: [], incomplete: [] };
  const { plans, expectedGeneration } = db.transaction(() => ({
    plans: planSnapshots(db, season, nowUtc), expectedGeneration: generation(db, season)
  })).deferred();
  const keys = new Set(plans.map(p => p.key));
  try {
    transaction(db, () => {
      if (generation(db, season) !== expectedGeneration) throw new StaleInputError();
      for (const row of rows<{ snapshot_key: string; kind: string }>(db,
        `SELECT p.snapshot_key, s.kind FROM snapshot_publications p JOIN snapshots s
         ON s.snapshot_key=p.snapshot_key AND s.revision=p.revision WHERE s.season=?`, season)) {
        if (!keys.has(row.snapshot_key)) db.query("UPDATE snapshot_publications SET state='stale' WHERE snapshot_key=?")
          .run(row.snapshot_key);
      }
    });
  } catch (error) {
    if (!(error instanceof StaleInputError)) throw error;
    report.incomplete.push({ key: `${season}:season`, reasons: ["source changed during rebuild; retry"] });
    return report;
  }
  for (const plan of plans) {
    let result: { changed: boolean; reasons: string[] };
    try { result = build(db, plan, nowUtc, expectedGeneration, options); }
    catch (error) {
      if (!(error instanceof StaleInputError)) throw error;
      report.incomplete.push({ key: plan.key, reasons: ["source changed during rebuild; retry"] });
      break;
    }
    if (result.reasons.length) report.incomplete.push({ key: plan.key, reasons: result.reasons });
    (result.changed ? report.published : report.unchanged).push(plan.key);
  }
  return report;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.length !== 2 || args[0] !== "--season" || !/^\d{4}$/.test(args[1] ?? ""))
    throw new Error("Usage: bun run snapshots:rebuild --season YEAR");
  const db = openDatabase(configFromEnv());
  try {
    await migrate(db);
    console.log(JSON.stringify(rebuildSnapshots(db, Number(args[1])), null, 2));
  } finally { db.close(); }
}

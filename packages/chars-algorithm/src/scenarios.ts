import { computeColley } from "./colley";
import { computeEligibility, includedRegularGames, type SeasonGames } from "./eligibility";
import { computePlayoff } from "./brackets";
import type { SelectionInput } from "./selection";
import { POLL_MODEL_VERSION, SOLVER_VERSION, type Game, type ScenarioProof, type ScenarioWitness, type SnapshotIdentity } from "./index";

export interface ScenarioInput extends SeasonGames {
  /** Completed games are frozen; only uncompleted regular games are assigned outcomes. */
  snapshot: SnapshotIdentity;
  /** Last instant whose results are known at the snapshot. */
  gameCutoffUtc: string;
  /** Games kicking off at/after this instant are outside selection. */
  selectionFreezeUtc: string;
  /** Caller attests the supplied schedule contains every known pre-freeze game. */
  scheduleComplete: boolean;
  /** Historical seasons only (before the 1996 overtime rule). Defaults to false. */
  allowHistoricalTies?: boolean;
  /** Upper bound on terminal game/poll combinations. Defaults to 10,000. */
  maxCompletions?: number;
  /** Wall-clock budget in milliseconds. Defaults to 30,000. */
  maxRuntimeMs?: number;
  /** Maximum stored distinct win-out game paths across teams. Defaults to 10,000. */
  maxTrackedPollPaths?: number;
  /** Number of deterministic poll-equivalence leaves already processed by a prior run. */
  startCompletion?: number;
  /** Previously persisted witnesses; never treated as proof without matching input identity. */
  initialWitnesses?: Record<string, ScenarioWitness[]>;
}

export interface ScenarioResult {
  proofs: ScenarioProof[];
  /** Fixed known schedule and eligible-voter poll universe, not a forecast of voters. */
  assumptions: string[];
  /** Exhaustive game/poll-equivalence classes evaluated, shared by all proofs. */
  evaluatedCompletions: number;
  possibleCompletions: number | null;
  pendingReason: string | null;
  nextCompletion: number;
  complete: boolean;
}

type Outcome = "home" | "away" | "tie";
type WitnessKind = ScenarioWitness["kind"];
const KINDS: WitnessKind[] = ["qualifying", "failing", "qualifying_win_out", "failing_win_out"];

function pollOrderCount(n: number): number {
  let count = 1;
  // Four eligible teams are automatic minimum bids. Poll order matters only
  // through the set of additions filling the remaining eight invitations.
  const candidates = Math.max(0, n - 4), slots = Math.min(8, candidates);
  for (let i = 1; i <= slots; i++) count = count * (candidates - slots + i) / i;
  return count;
}

/** Pure, exhaustive small-schedule certificate; never turns a partial search into a label. */
export function computeScenarios(input: ScenarioInput): ScenarioResult {
  const started = Date.now();
  const { season, teams, games, snapshot } = input;
  if (snapshot.season !== season) throw new Error("Scenario snapshot season mismatch");
  if (input.allowHistoricalTies && season >= 1996) throw new Error("Future ties are allowed only before 1996");
  const maxCompletions = input.maxCompletions ?? 10_000;
  const maxRuntimeMs = input.maxRuntimeMs ?? 30_000;
  const maxTrackedPollPaths = input.maxTrackedPollPaths ?? 10_000;
  if (!Number.isSafeInteger(maxCompletions) || maxCompletions < 1 ||
    !Number.isFinite(maxRuntimeMs) || maxRuntimeMs < 0 ||
    !Number.isSafeInteger(maxTrackedPollPaths) || maxTrackedPollPaths < 1) throw new Error("Invalid scenario budget");
  const startCompletion = input.startCompletion ?? 0;
  if (!Number.isSafeInteger(startCompletion) || startCompletion < 0) throw new Error("Invalid scenario cursor");
  // Validate even excluded games. Missing opponent membership is an unresolved
  // coverage gap, not evidence that the game can be discarded.
  let validationGap: string | null = null;
  try { includedRegularGames({ season, teams, games }); }
  catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith("Unknown or wrong-season opponent in ")) throw error;
    validationGap = error.message;
  }
  const fbs = teams.filter(team => team.membership === "fbs").map(team => team.teamId).sort();
  const membership = new Map(teams.map(team => [team.teamId, team.membership]));
  const parseUtc = (value: string) => /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{3})?Z$/.test(value) &&
    !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() ===
      (value.includes(".") ? value : value.replace("Z", ".000Z")) ? Date.parse(value) : NaN;
  const cutoff = parseUtc(input.gameCutoffUtc), freeze = parseUtc(input.selectionFreezeUtc);
  if (!Number.isFinite(cutoff) || !Number.isFinite(freeze) || cutoff >= freeze) {
    throw new Error("Invalid scenario game cutoff or selection freeze UTC");
  }
  const relevant = (game: Game) => membership.get(game.homeTeamId) === "fbs" ||
    membership.get(game.awayTeamId) === "fbs";
  let dataGap: string | null = validationGap ?? (input.scheduleComplete === true ? null :
    "Complete known pre-freeze regular schedule has not been attested");
  const includedGames: Game[] = [];
  for (const game of games) {
    if (!relevant(game)) continue; // FCS-FCS outcomes cannot change FBS records, ratings, or selection.
    const kickoff = game.kickoffUtc === null ? null : parseUtc(game.kickoffUtc);
    if (kickoff !== null && !Number.isFinite(kickoff)) {
      dataGap ??= `Invalid kickoff timestamp for relevant game ${game.id}`;
      continue;
    }
    if (kickoff !== null && kickoff >= freeze) continue;
    if (game.status === "cancelled") continue;
    if (game.applicationGameType === "unknown") {
      dataGap ??= `Unresolved pre-freeze game classification: ${game.id}`;
      continue;
    }
    if (game.applicationGameType !== "regular") continue;
    if (membership.get(game.homeTeamId) === "other" || membership.get(game.awayTeamId) === "other") {
      dataGap ??= `Unresolved opponent membership for pre-freeze game ${game.id}`;
      continue;
    }
    if (game.completed && (kickoff === null || kickoff > cutoff)) {
      dataGap ??= `Completed game ${game.id} has unknown kickoff or occurs after snapshot game cutoff`;
      continue;
    }
    if (!game.completed && (kickoff === null || kickoff <= cutoff)) {
      dataGap ??= `Unresolved future kickoff or result for pre-freeze game ${game.id}`;
      continue;
    }
    includedGames.push(game);
  }
  const remaining = includedGames.filter(game => !game.completed);
  const assumptions = ["fixed remaining included regular-season schedule; no future cancellation or additions",
    "completed included results frozen; future CCGs, bowls and playoff games excluded",
    "all eligible poll orders; terminal eligible FBS teams only, up to 25 distinct entries",
    input.allowHistoricalTies ? "historical future ties permitted" : "future games have two decisive outcomes",
    `game cutoff ${input.gameCutoffUtc}; selection freeze ${input.selectionFreezeUtc}; complete known schedule attested`,
    `poll model ${POLL_MODEL_VERSION}; solver ${SOLVER_VERSION}`];
  const scheduleFingerprint = JSON.stringify([season,
    input.gameCutoffUtc, input.selectionFreezeUtc, input.scheduleComplete,
    teams.map(t => [t.teamId, t.membership]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    games.map(g => [g.id, g.homeTeamId, g.awayTeamId, g.applicationGameType, g.status,
      g.kickoffUtc, g.homeScore, g.awayScore]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))]);
  const base = { snapshotKey: snapshot.key, snapshotRevision: snapshot.revision,
    pollModelVersion: POLL_MODEL_VERSION, solverVersion: SOLVER_VERSION };
  const buckets = new Map(fbs.map(teamId => [teamId, new Map<WitnessKind, ScenarioWitness>()]));
  for (const [teamId, witnesses] of Object.entries(input.initialWitnesses ?? {})) {
    const bucket = buckets.get(teamId);
    if (!bucket) throw new Error(`Unknown checkpoint team ${teamId}`);
    for (const witness of witnesses) {
      if (!KINDS.includes(witness.kind)) throw new Error("Invalid checkpoint witness");
      bucket.set(witness.kind, witness);
    }
  }
  const pollVariation = new Map<string, { qualifying?: ScenarioWitness; failing?: ScenarioWitness }>();
  const variableOutcomes: Outcome[] = input.allowHistoricalTies ? ["home", "away", "tie"] : ["home", "away"];
  let largestSpace: number | null = null;
  let evaluatedCompletions = 0;
  let visitedCompletions = 0;
  let pendingReason: string | null = null;
  const recordEliminated = new Set<string>();
  const makeProof = (teamId: string, reason: string): ScenarioProof => {
    const eliminated = recordEliminated.has(teamId) && !dataGap;
    const r = completedRecords?.get(teamId)?.record;
    const future = remaining.filter(g => g.homeTeamId === teamId || g.awayTeamId === teamId).length;
    const total = r ? r.wins + r.losses + r.ties + future : 0;
    const eligibilityBounds = r && !dataGap ? {
      possible: total > 0 && 4 * (r.wins + future) + 2 * r.ties >= 3 * total,
      guaranteed: total > 0 && 4 * r.wins + 2 * r.ties >= 3 * total,
      minimumPercentageNumerator: 4 * r.wins + 2 * r.ties,
      maximumPercentageNumerator: 4 * (r.wins + future) + 2 * r.ties,
      thresholdNumerator: 3 * total, future
    } : null;
    return { ...base, teamId, state: eliminated ? "proved" : "pending",
      label: eliminated ? "eliminated" : null, assumptions,
      proofMetadata: eliminated ? JSON.stringify({ certificate: "exact maximum terminal record below .750",
        scheduleFingerprint, snapshotInputHash: snapshot.inputHash,
        fixedScheduleGameIds: remaining.map(game => game.id),
        record: { wins: r!.wins, losses: r!.losses, ties: r!.ties, ...eligibilityBounds } }) :
        JSON.stringify({ pendingReason: reason, eligibilityBounds,
          certificate: "eligibility bounds only; no selection claim", scheduleFingerprint,
          snapshotInputHash: snapshot.inputHash }),
      runtimeMs: Date.now() - started,
      witnesses: KINDS.flatMap(kind => buckets.get(teamId)!.get(kind) ? [buckets.get(teamId)!.get(kind)!] : []) };
  };
  let completedRecords: ReturnType<typeof computeEligibility> | null = null;
  const pending = (reason: string): ScenarioResult => ({
    proofs: fbs.map(teamId => makeProof(teamId, reason)),
    assumptions, evaluatedCompletions, possibleCompletions: largestSpace !== null &&
      Number.isSafeInteger(largestSpace) ? largestSpace : null,
    pendingReason: reason, nextCompletion: startCompletion + evaluatedCompletions, complete: false
  });
  if (dataGap) return pending(dataGap);
  completedRecords = computeEligibility({ season, teams, games: includedGames });
  for (const id of fbs) {
    const record = completedRecords.get(id)!.record;
    const future = remaining.filter(game => game.homeTeamId === id || game.awayTeamId === id).length;
    const total = record.wins + record.losses + record.ties + future;
    // No selection route (including swaps or eligible-voter poll additions) waives .750.
    if (!total || 4 * (record.wins + future) + 2 * record.ties < 3 * total) recordEliminated.add(id);
  }
  const maximumEligible = fbs.filter(id => {
    const record = completedRecords!.get(id)!.record;
    const future = remaining.filter(game => game.homeTeamId === id || game.awayTeamId === id).length;
    const total = record.wins + record.losses + record.ties + future;
    return total > 0 && 4 * (record.wins + future) + 2 * record.ties >= 3 * total;
  }).length;
  if (recordEliminated.size === fbs.length) return {
    proofs: fbs.map(id => makeProof(id, "")), assumptions, evaluatedCompletions: 0,
    possibleCompletions: null, pendingReason: null, nextCompletion: startCompletion, complete: true
  };
  largestSpace = variableOutcomes.length ** remaining.length * pollOrderCount(maximumEligible);
  // Standalone/default exhaustive calls cannot finish a larger-than-budget
  // space. Return sound record proofs immediately rather than spending seconds
  // sampling poll orders that cannot certify any other status. Explicitly
  // budgeted/resumable worker calls still make incremental witness progress.
  if (input.startCompletion === undefined && input.maxCompletions === undefined &&
    (!Number.isSafeInteger(largestSpace) || largestSpace > maxCompletions))
    return pending(`Full upper bound ${largestSpace} terminal completions exceeds cap ${maxCompletions}; no classification attempted`);
  const outcomes: Record<string, Outcome> = {};
  const terminalGames: Game[] = [...includedGames];
  function evaluate(pollOrder: string[], terminal: SeasonGames,
    ratings: ReturnType<typeof computeColley>, records: SelectionInput["records"]): void {
    const bracket = computePlayoff({ ...terminal, ratings, records,
      pollEntries: pollOrder.map((teamId, index) => ({ teamId, rank: index + 1 })) }, snapshot);
    const qualified = new Set([...bracket.seeding.selection.bid, ...bracket.seeding.selection.playin]);
    evaluatedCompletions++;
    for (const teamId of fbs) {
      const winOut = remaining.every(game => game.homeTeamId !== teamId && game.awayTeamId !== teamId ||
        outcomes[game.id] === (game.homeTeamId === teamId ? "home" : "away"));
      const qualifies = qualified.has(teamId);
      const kinds: WitnessKind[] = [qualifies ? "qualifying" : "failing"];
      if (winOut) kinds.push(qualifies ? "qualifying_win_out" : "failing_win_out");
      const witness: ScenarioWitness = { kind: kinds[0]!, gameOutcomes: { ...outcomes },
        pollOrderTeamIds: [...pollOrder], assumptions: ["one possible path, not a sufficient or necessary condition",
          `eligible poll order: ${pollOrder.join(" > ") || "empty"}`] };
      for (const kind of kinds) if (!buckets.get(teamId)!.has(kind)) {
        buckets.get(teamId)!.set(kind, { ...witness, kind });
      }
      if (winOut) {
        const key = JSON.stringify([teamId, outcomes]);
        if (!pollVariation.has(key) && pollVariation.size >= maxTrackedPollPaths) {
          pendingReason = `Poll-path memory budget ${maxTrackedPollPaths} exhausted`;
          return;
        }
        const variation = pollVariation.get(key) ?? {};
        variation[qualifies ? "qualifying" : "failing"] = witness;
        pollVariation.set(key, variation);
      }
    }
  }
  function polls(eligible: string[], automatic: Set<string>, chosen: string[], offset: number,
    count: number, terminal: SeasonGames, ratings: ReturnType<typeof computeColley>,
    records: SelectionInput["records"]): void {
    if (pendingReason) return;
    const candidates = eligible.filter(id => !automatic.has(id));
    if (chosen.length === count) {
      if (visitedCompletions++ < startCompletion) return;
      if (evaluatedCompletions >= maxCompletions) { pendingReason = `Scenario completion budget ${maxCompletions} exhausted`; return; }
      if (Date.now() - started >= maxRuntimeMs) { pendingReason = "Scenario runtime budget exhausted"; return; }
      const selected = new Set(chosen);
      const order = [...chosen, ...eligible.filter(id => !selected.has(id))].slice(0, 25);
      evaluate(order, terminal, ratings, records);
      return;
    }
    for (let i = offset; i <= candidates.length - (count - chosen.length); i++) {
      chosen.push(candidates[i]!);
      polls(eligible, automatic, chosen, i + 1, count, terminal, ratings, records);
      chosen.pop();
      if (pendingReason) return;
    }
  }
  function schedules(index: number): void {
    if (pendingReason) return;
    if (Date.now() - started >= maxRuntimeMs) { pendingReason = "Scenario runtime budget exhausted"; return; }
    if (index === remaining.length) {
      const terminal = { season, teams, games: terminalGames };
      const records = computeEligibility(terminal);
      const eligible = [...records].filter(([, entry]) => entry.eligible).map(([id]) => id).sort();
      const ratings = computeColley(terminal);
      const recordList = [...records].map(([teamId, value]) => ({ teamId, record: value.record }));
      const automatic = computePlayoff({ ...terminal, ratings, records: recordList, pollEntries: [] }, snapshot)
        .seeding.selection;
      const selected = new Set([...automatic.initialBid, ...automatic.initialPlayin]);
      polls(eligible, selected, [], 0, Math.min(Math.max(0, 12 - selected.size), eligible.length - selected.size),
        terminal, ratings, recordList);
      return;
    }
    const game = remaining[index]!;
    for (const outcome of variableOutcomes) {
      outcomes[game.id] = outcome;
      terminalGames[includedGames.indexOf(game)] = { ...game, completed: true, status: "completed",
        homeScore: outcome === "away" ? 0 : 1, awayScore: outcome === "home" ? 0 : 1 };
      schedules(index + 1);
      if (pendingReason) return;
    }
  }
  schedules(0);
  if (pendingReason) return pending(pendingReason);
  const proofs: ScenarioProof[] = fbs.map(teamId => {
    const found = buckets.get(teamId)!;
    if (recordEliminated.has(teamId)) return makeProof(teamId, "");
    const qualifying = found.has("qualifying"), failing = found.has("failing");
    const winQualifying = found.has("qualifying_win_out"), winFailing = found.has("failing_win_out");
    const label = !failing ? "clinched" : !qualifying ? "eliminated" :
      !winFailing ? "controls_destiny" : winQualifying ? "needs_help" : null;
    const state = label ? "proved" : "unsupported";
    const pollPair = label === "needs_help" ? [...pollVariation].find(([key, value]) =>
      JSON.parse(key)[0] === teamId && value.qualifying && value.failing)?.[1] : undefined;
    if (pollPair?.qualifying && pollPair.failing) {
      found.set("qualifying_win_out", { ...pollPair.qualifying, kind: "qualifying_win_out" });
      found.set("failing_win_out", { ...pollPair.failing, kind: "failing_win_out" });
    }
    const pollDependent = Boolean(pollPair) || label === "needs_help" &&
      found.has("qualifying_win_out") && found.has("failing_win_out") &&
      JSON.stringify(found.get("qualifying_win_out")!.gameOutcomes) ===
        JSON.stringify(found.get("failing_win_out")!.gameOutcomes);
    return { ...base, teamId, state, label, assumptions,
      proofMetadata: JSON.stringify({ certificate: "exhaustive poll-equivalence classes", evaluatedCompletions,
        scheduleFingerprint, snapshotInputHash: snapshot.inputHash,
        fixedScheduleGameIds: remaining.map(game => game.id), pollDependent,
        exception: label ? null : "qualifies only outside winning-out completions; policy/model review required" }),
      runtimeMs: Date.now() - started,
      witnesses: KINDS.flatMap(kind => found.get(kind) ? [found.get(kind)!] : []) };
  });
  return { proofs, assumptions, evaluatedCompletions, possibleCompletions: visitedCompletions,
    pendingReason: null, nextCompletion: startCompletion + evaluatedCompletions, complete: true };
}

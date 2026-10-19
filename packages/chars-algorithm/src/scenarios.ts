import { computeColley } from "./colley";
import { computeEligibility, includedRegularGames, type SeasonGames } from "./eligibility";
import { computePlayoff } from "./brackets";
import { POLL_MODEL_VERSION, SOLVER_VERSION, type Game, type ScenarioProof, type ScenarioWitness, type SnapshotIdentity } from "./index";

export interface ScenarioInput extends SeasonGames {
  /** Completed games are frozen; only uncompleted regular games are assigned outcomes. */
  snapshot: SnapshotIdentity;
  /** Historical seasons only (before the 1996 overtime rule). Defaults to false. */
  allowHistoricalTies?: boolean;
  /** Upper bound on terminal game/poll combinations. Defaults to 10,000. */
  maxCompletions?: number;
  /** Wall-clock budget in milliseconds. Defaults to 30,000. */
  maxRuntimeMs?: number;
  /** Maximum stored distinct win-out game paths across teams. Defaults to 10,000. */
  maxTrackedPollPaths?: number;
}

export interface ScenarioResult {
  proofs: ScenarioProof[];
  /** Fixed known schedule and eligible-voter poll universe, not a forecast of voters. */
  assumptions: string[];
  /** Exhaustive game/poll-equivalence classes evaluated, shared by all proofs. */
  evaluatedCompletions: number;
  possibleCompletions: number | null;
  pendingReason: string | null;
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
  // Validate the whole snapshot (including excluded and incomplete games) with the terminal engine's validator.
  includedRegularGames({ season, teams, games });
  const remaining = games.filter(game => !game.completed && game.applicationGameType === "regular" &&
    game.status !== "cancelled");
  const fbs = teams.filter(team => team.membership === "fbs").map(team => team.teamId).sort();
  const assumptions = ["fixed remaining included regular-season schedule; no future cancellation or additions",
    "completed included results frozen; future CCGs, bowls and playoff games excluded",
    "all eligible poll orders; terminal eligible FBS teams only, up to 25 distinct entries",
    input.allowHistoricalTies ? "historical future ties permitted" : "future games have two decisive outcomes",
    `poll model ${POLL_MODEL_VERSION}; solver ${SOLVER_VERSION}`];
  const scheduleFingerprint = JSON.stringify([season,
    teams.map(t => [t.teamId, t.membership]).sort((a, b) => String(a[0]).localeCompare(String(b[0]))),
    games.map(g => [g.id, g.homeTeamId, g.awayTeamId, g.applicationGameType, g.status,
      g.homeScore, g.awayScore]).sort((a, b) => String(a[0]).localeCompare(String(b[0])))]);
  const base = { snapshotKey: snapshot.key, snapshotRevision: snapshot.revision,
    pollModelVersion: POLL_MODEL_VERSION, solverVersion: SOLVER_VERSION };
  const buckets = new Map(fbs.map(teamId => [teamId, new Map<WitnessKind, ScenarioWitness>()]));
  const pollVariation = new Map<string, { qualifying?: ScenarioWitness; failing?: ScenarioWitness }>();
  const variableOutcomes: Outcome[] = input.allowHistoricalTies ? ["home", "away", "tie"] : ["home", "away"];
  const completedRecords = computeEligibility({ season, teams, games });
  const maximumEligible = fbs.filter(id => {
    const record = completedRecords.get(id)!.record;
    const future = remaining.filter(game => game.homeTeamId === id || game.awayTeamId === id).length;
    const total = record.wins + record.losses + record.ties + future;
    return total > 0 && 4 * (record.wins + future) + 2 * record.ties >= 3 * total;
  }).length;
  const largestSpace = variableOutcomes.length ** remaining.length * pollOrderCount(maximumEligible);
  let evaluatedCompletions = 0;
  let pendingReason: string | null = null;
  const pending = (reason: string): ScenarioResult => ({
    proofs: fbs.map(teamId => ({ ...base, teamId, state: "pending", label: null, assumptions,
      proofMetadata: reason, runtimeMs: Date.now() - started, witnesses: KINDS.flatMap(kind =>
        buckets.get(teamId)!.get(kind) ? [buckets.get(teamId)!.get(kind)!] : []) })),
    assumptions, evaluatedCompletions, possibleCompletions: Number.isSafeInteger(largestSpace) ? largestSpace : null,
    pendingReason: reason
  });
  if (!Number.isSafeInteger(largestSpace) || largestSpace > maxCompletions) {
    return pending(`Full upper bound ${largestSpace} terminal completions exceeds cap ${maxCompletions}; no classification attempted`);
  }
  const outcomes: Record<string, Outcome> = {};
  const terminalGames: Game[] = [...games];
  function evaluate(pollOrder: string[]): void {
    const terminal = { season, teams, games: terminalGames };
    const eligibility = computeEligibility(terminal);
    const records = [...eligibility].map(([teamId, value]) => ({ teamId, record: value.record }));
    const bracket = computePlayoff({ ...terminal, ratings: computeColley(terminal), records,
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
    count: number): void {
    if (pendingReason) return;
    const candidates = eligible.filter(id => !automatic.has(id));
    if (chosen.length === count) {
      if (Date.now() - started >= maxRuntimeMs) { pendingReason = "Scenario runtime budget exhausted"; return; }
      const selected = new Set(chosen);
      const order = [...chosen, ...eligible.filter(id => !selected.has(id))].slice(0, 25);
      evaluate(order);
      return;
    }
    for (let i = offset; i <= candidates.length - (count - chosen.length); i++) {
      chosen.push(candidates[i]!);
      polls(eligible, automatic, chosen, i + 1, count);
      chosen.pop();
      if (pendingReason) return;
    }
  }
  function schedules(index: number): void {
    if (pendingReason) return;
    if (Date.now() - started >= maxRuntimeMs) { pendingReason = "Scenario runtime budget exhausted"; return; }
    if (index === remaining.length) {
      const terminal = { season, teams, games: terminalGames };
      const eligible = [...computeEligibility(terminal)].filter(([, entry]) => entry.eligible).map(([id]) => id).sort();
      const ratings = computeColley(terminal);
      const records = [...computeEligibility(terminal)].map(([teamId, value]) => ({ teamId, record: value.record }));
      const automatic = computePlayoff({ ...terminal, ratings, records, pollEntries: [] }, snapshot)
        .seeding.selection;
      const selected = new Set([...automatic.initialBid, ...automatic.initialPlayin]);
      polls(eligible, selected, [], 0, Math.min(Math.max(0, 12 - selected.size), eligible.length - selected.size));
      return;
    }
    const game = remaining[index]!;
    for (const outcome of variableOutcomes) {
      outcomes[game.id] = outcome;
      terminalGames[games.indexOf(game)] = { ...game, completed: true, status: "completed",
        homeScore: outcome === "away" ? 0 : 1, awayScore: outcome === "home" ? 0 : 1 };
      schedules(index + 1);
      if (pendingReason) return;
    }
  }
  schedules(0);
  if (pendingReason) return pending(pendingReason);
  const proofs: ScenarioProof[] = fbs.map(teamId => {
    const found = buckets.get(teamId)!;
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
    return { ...base, teamId, state, label, assumptions,
      proofMetadata: JSON.stringify({ certificate: "exhaustive poll-equivalence classes", evaluatedCompletions,
        scheduleFingerprint, snapshotInputHash: snapshot.inputHash,
        fixedScheduleGameIds: remaining.map(game => game.id), pollDependent: Boolean(pollPair),
        exception: label ? null : "qualifies only outside winning-out completions; policy/model review required" }),
      runtimeMs: Date.now() - started,
      witnesses: KINDS.flatMap(kind => found.get(kind) ? [found.get(kind)!] : []) };
  });
  return { proofs, assumptions, evaluatedCompletions, possibleCompletions: evaluatedCompletions,
    pendingReason: null };
}

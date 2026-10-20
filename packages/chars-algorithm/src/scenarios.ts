import { createHash, createHmac, timingSafeEqual } from "node:crypto";
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
  /** Serialized frontier upper bound in bytes. Defaults to 16 MiB. */
  maxCheckpointBytes?: number;
  /** Opaque authenticated frontier. Resumption requires the separately supplied verifier key. */
  checkpoint?: ScenarioCheckpoint;
}

export interface ScenarioCheckpoint {
  payload: {
    inputDigest: string;
    gameIndex: string;
    pollIndex: string;
    evaluated: number;
    witnesses: Record<string, Partial<Record<ScenarioWitness["kind"], ScenarioWitness>>>;
    pollPairs: Record<string, Record<string, { qualifying?: ScenarioWitness; failing?: ScenarioWitness }>>;
  };
  digest: string;
}

export interface ScenarioResult {
  proofs: ScenarioProof[];
  /** Fixed known schedule and eligible-voter poll universe, not a forecast of voters. */
  assumptions: string[];
  /** Exhaustive game/poll-equivalence classes evaluated, shared by all proofs. */
  evaluatedCompletions: number;
  possibleCompletions: number | null;
  pendingReason: string | null;
  /** A fixed memory cap blocked the current leaf; raise the cap before retrying. */
  unsupportedReason: string | null;
  nextCompletion: number;
  complete: boolean;
  checkpoint: ScenarioCheckpoint | null;
}

type Outcome = "home" | "away" | "tie";
type WitnessKind = ScenarioWitness["kind"];
const KINDS: WitnessKind[] = ["qualifying", "failing", "qualifying_win_out", "failing_win_out"];

const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sign = (value: unknown, key: string) => createHmac("sha256", key).update(JSON.stringify(value)).digest("hex");
const hexBytes = (hex: string) => Uint8Array.from(hex.match(/../g)!, part => parseInt(part, 16));
function choose(n: number, k: number): bigint {
  let result = 1n;
  for (let i = 1; i <= k; i++) result = result * BigInt(n - k + i) / BigInt(i);
  return result;
}
function subsetAt(candidates: string[], count: number, rank: bigint): string[] {
  const result: string[] = [];
  for (let start = 0; count; count--) {
    for (let i = start; i <= candidates.length - count; i++) {
      const block = choose(candidates.length - i - 1, count - 1);
      if (rank < block) { result.push(candidates[i]!); start = i + 1; break; }
      rank -= block;
    }
  }
  return result;
}

/** Pure, exhaustive small-schedule certificate; never turns a partial search into a label. */
/** The verifier key is a privileged DB-held capability, never part of public input or checkpoint JSON. */
export function computeScenarios(input: ScenarioInput, verifierKey?: string): ScenarioResult {
  const started = Date.now();
  const { season, teams, games, snapshot } = input;
  if (snapshot.season !== season) throw new Error("Scenario snapshot season mismatch");
  if (input.allowHistoricalTies && season >= 1996) throw new Error("Future ties are allowed only before 1996");
  const maxCompletions = input.maxCompletions ?? 10_000;
  const maxRuntimeMs = input.maxRuntimeMs ?? 30_000;
  const maxTrackedPollPaths = input.maxTrackedPollPaths ?? 10_000;
  const maxCheckpointBytes = input.maxCheckpointBytes ?? 16 * 1024 * 1024;
  if (!Number.isSafeInteger(maxCompletions) || maxCompletions < 1 ||
    !Number.isFinite(maxRuntimeMs) || maxRuntimeMs < 0 ||
    !Number.isSafeInteger(maxTrackedPollPaths) || maxTrackedPollPaths < 1 ||
    !Number.isSafeInteger(maxCheckpointBytes) || maxCheckpointBytes < 1024)
    throw new Error("Invalid scenario budget");
  if ("startCompletion" in input || "initialWitnesses" in input)
    throw new Error("Unverified scenario cursor/witnesses are unsupported; supply a verified checkpoint");
  if (verifierKey !== undefined && !/^[a-f0-9]{64}$/.test(verifierKey))
    throw new Error("Invalid scenario verifier key");
  // Validate even excluded games. Missing opponent membership is an unresolved
  // coverage gap, not evidence that the game can be discarded.
  let validationGap: string | null = null;
  try { includedRegularGames({ season, teams, games }); }
  catch (error) {
    if (!(error instanceof Error) || !error.message.startsWith("Unknown or wrong-season opponent in ")) throw error;
    validationGap = error.message;
  }
  const codepoint = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  const fbs = teams.filter(team => team.membership === "fbs").map(team => team.teamId).sort(codepoint);
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
  includedGames.sort((a, b) => codepoint(a.id, b.id));
  const remaining = includedGames.filter(game => !game.completed);
  const assumptions = ["fixed remaining included regular-season schedule; no future cancellation or additions",
    "completed included results frozen; future CCGs, bowls and playoff games excluded",
    "all eligible poll orders; terminal eligible FBS teams only, up to 25 distinct entries",
    input.allowHistoricalTies ? "historical future ties permitted" : "future games have two decisive outcomes",
    `game cutoff ${input.gameCutoffUtc}; selection freeze ${input.selectionFreezeUtc}; complete known schedule attested`,
    `poll model ${POLL_MODEL_VERSION}; solver ${SOLVER_VERSION}`];
  const scheduleFingerprint = hash([snapshot, season, input.gameCutoffUtc, input.selectionFreezeUtc,
    input.scheduleComplete, input.allowHistoricalTies === true, POLL_MODEL_VERSION, SOLVER_VERSION,
    teams.map(t => [t.season, t.teamId, t.membership]).sort((a, b) => codepoint(String(a[1]), String(b[1]))),
    games.map(g => [g.id, g.providerGameId, g.season, g.homeTeamId, g.awayTeamId,
      g.applicationGameType, g.status, g.completed, g.kickoffUtc, g.homeScore, g.awayScore,
       g.resultRevision]).sort((a, b) => codepoint(String(a[0]), String(b[0])))]);
  const base = { snapshotKey: snapshot.key, snapshotRevision: snapshot.revision,
    pollModelVersion: POLL_MODEL_VERSION, solverVersion: SOLVER_VERSION };
  const initial = { inputDigest: scheduleFingerprint, gameIndex: "0", pollIndex: "0", evaluated: 0,
    witnesses: Object.fromEntries(fbs.map(id => [id, {}])) as ScenarioCheckpoint["payload"]["witnesses"],
    pollPairs: Object.fromEntries(fbs.map(id => [id, {}])) as ScenarioCheckpoint["payload"]["pollPairs"] };
  if (input.checkpoint) {
    const { payload, digest } = input.checkpoint;
    if (!verifierKey || !payload || typeof digest !== "string" || !/^[a-f0-9]{64}$/.test(digest) ||
      !timingSafeEqual(hexBytes(digest), hexBytes(sign(payload, verifierKey))) ||
      payload.inputDigest !== scheduleFingerprint ||
      !/^(0|[1-9]\d*)$/.test(payload.gameIndex) || !/^(0|[1-9]\d*)$/.test(payload.pollIndex) ||
      !Number.isSafeInteger(payload.evaluated) || payload.evaluated < 0 ||
      !payload.witnesses || !payload.pollPairs ||
      Object.keys(payload.witnesses).sort().join("|") !== fbs.join("|") ||
      Object.keys(payload.pollPairs).sort().join("|") !== fbs.join("|"))
      throw new Error("Unverified scenario checkpoint");
  }
  // Clone untrusted state: the caller cannot mutate the accumulator during a run.
  const progress: ScenarioCheckpoint["payload"] = input.checkpoint ?
    JSON.parse(JSON.stringify(input.checkpoint.payload)) as ScenarioCheckpoint["payload"] : initial;
  let frontierBytes = new TextEncoder().encode(JSON.stringify(progress)).length;
  let trackedPaths = Object.values(progress.pollPairs).reduce((n, paths) => n + Object.keys(paths).length, 0);
  const variableOutcomes: Outcome[] = input.allowHistoricalTies ? ["home", "away", "tie"] : ["home", "away"];
  const totalGames = BigInt(variableOutcomes.length) ** BigInt(remaining.length);
  const maximumSpace = totalGames * choose(Math.max(0, fbs.length - 4), Math.min(8, Math.max(0, fbs.length - 4)));
  const largestSpace = maximumSpace <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(maximumSpace) : null;
  let evaluatedCompletions = 0;
  let pendingReason: string | null = null;
  let unsupportedReason: string | null = null;
  const recordEliminated = new Set<string>();
  const boundWitnessNotes = new Map<string, string>();
  const recordsById = new Map<string, { wins: number; losses: number; ties: number; future: number;
    possible: boolean; guaranteed: boolean }>();
  let allEligibleBound = false;
  const checkpoint = (): ScenarioCheckpoint | null => verifierKey ?
    { payload: progress, digest: sign(progress, verifierKey) } : null;
  const makeProof = (teamId: string, reason: string): ScenarioProof => {
    const bound = recordsById.get(teamId);
    const eliminated = recordEliminated.has(teamId) && !dataGap;
    const boundLabel = !dataGap && allEligibleBound && bound?.possible ?
      bound.guaranteed ? "clinched" : "controls_destiny" : null;
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
    return { ...base, teamId, state: eliminated || boundLabel ? "proved" : unsupportedReason ? "unsupported" : "pending",
      label: eliminated ? "eliminated" : boundLabel, assumptions,
      proofMetadata: eliminated || boundLabel ? JSON.stringify({ certificate: eliminated ?
        "exact maximum terminal record below .750" : "selection-aware eligible universe at most twelve",
        scheduleFingerprint, snapshotInputHash: snapshot.inputHash,
        fixedScheduleGameIds: remaining.map(game => game.id),
        qualifyingWitness: boundLabel ? boundWitnessNotes.get(teamId) ?? "not materialized" : null,
        record: { wins: r!.wins, losses: r!.losses, ties: r!.ties, ...eligibilityBounds } }) :
         JSON.stringify({ pendingReason: reason, unsupportedReason, eligibilityBounds,
          certificate: "eligibility bounds only; no selection claim", scheduleFingerprint,
          snapshotInputHash: snapshot.inputHash }),
      runtimeMs: Date.now() - started,
      witnesses: KINDS.flatMap(kind => progress.witnesses[teamId]?.[kind] ? [progress.witnesses[teamId]![kind]!] : []) };
  };
  let completedRecords: ReturnType<typeof computeEligibility> | null = null;
  const pending = (reason: string): ScenarioResult => ({
    proofs: fbs.map(teamId => makeProof(teamId, reason)),
    assumptions, evaluatedCompletions, possibleCompletions: largestSpace,
    pendingReason: reason, unsupportedReason, nextCompletion: progress.evaluated, complete: false,
    checkpoint: dataGap ? null : checkpoint()
  });
  if (dataGap) return pending(dataGap);
  completedRecords = computeEligibility({ season, teams, games: includedGames });
  for (const id of fbs) {
    const record = completedRecords.get(id)!.record;
    const future = remaining.filter(game => game.homeTeamId === id || game.awayTeamId === id).length;
    const total = record.wins + record.losses + record.ties + future;
    recordsById.set(id, { ...record, future, possible: total > 0 &&
      4 * (record.wins + future) + 2 * record.ties >= 3 * total,
      guaranteed: total > 0 && 4 * record.wins + 2 * record.ties >= 3 * total });
    // No selection route (including swaps or eligible-voter poll additions) waives .750.
    if (!total || 4 * (record.wins + future) + 2 * record.ties < 3 * total) recordEliminated.add(id);
  }
  const maximumEligible = fbs.filter(id => recordsById.get(id)!.possible).length;
  allEligibleBound = maximumEligible <= 12;
  if (allEligibleBound) {
    for (const teamId of fbs.filter(id => recordsById.get(id)!.possible)) {
      if (Date.now() - started >= maxRuntimeMs) {
        boundWitnessNotes.set(teamId, "not materialized: runtime budget exhausted; record/selection certificate remains valid");
        continue;
      }
      const outcomes: Record<string, Outcome> = {};
      const terminalGames = includedGames.map(game => {
        if (game.completed) return game;
        const result: Outcome = game.homeTeamId === teamId ? "home" : game.awayTeamId === teamId ? "away" : "home";
        outcomes[game.id] = result;
        return { ...game, completed: true, status: "completed" as const,
          homeScore: result === "home" ? 1 : 0, awayScore: result === "away" ? 1 : 0 };
      });
      const terminal: SeasonGames = { season, teams, games: terminalGames };
      const records = [...computeEligibility(terminal)].map(([id, entry]) => ({ teamId: id, record: entry.record }));
      const ratings = computeColley(terminal);
      const eligible = [...computeEligibility(terminal)].filter(([, entry]) => entry.eligible)
        .map(([id]) => id).sort(codepoint);
      const poll = [teamId, ...eligible.filter(id => id !== teamId)].slice(0, 25);
      const playoff = computePlayoff({ ...terminal, ratings, records,
        pollEntries: poll.map((id, rank) => ({ teamId: id, rank: rank + 1 })) }, snapshot);
      if (![...playoff.seeding.selection.bid, ...playoff.seeding.selection.playin].includes(teamId))
        throw new Error(`Selection-aware bound witness failed verification for ${teamId}`);
      const witness: ScenarioWitness = { kind: "qualifying", gameOutcomes: outcomes,
        pollOrderTeamIds: poll, assumptions: ["one possible path, not a sufficient or necessary condition",
          `eligible poll order: ${poll.join(" > ") || "empty"}`] };
      progress.witnesses[teamId]!.qualifying = witness;
      progress.witnesses[teamId]!.qualifying_win_out = { ...witness, kind: "qualifying_win_out" };
      boundWitnessNotes.set(teamId, "constructed and verified by terminal selection engine");
    }
    return {
    proofs: fbs.map(id => makeProof(id, "")), assumptions, evaluatedCompletions: 0,
    possibleCompletions: largestSpace, pendingReason: null, nextCompletion: progress.evaluated,
    unsupportedReason: null, complete: true, checkpoint: null
    };
  }
  if (BigInt(progress.gameIndex) > totalGames ||
    (BigInt(progress.gameIndex) === totalGames && progress.pollIndex !== "0") ||
    progress.evaluated > Number.MAX_SAFE_INTEGER - maxCompletions)
    throw new Error("Unverified scenario checkpoint cursor");
  if (frontierBytes > maxCheckpointBytes) unsupportedReason =
    `Checkpoint memory budget ${maxCheckpointBytes} bytes smaller than stored frontier ${frontierBytes} bytes`;
  // Every indexed leaf has a unique game outcome and poll subset. No sampled
  // prefix is ever promoted to a quantified result.
  while (BigInt(progress.gameIndex) < totalGames && evaluatedCompletions < maxCompletions &&
    Date.now() - started < maxRuntimeMs && !unsupportedReason) {
    let value = BigInt(progress.gameIndex);
    const outcomes: Record<string, Outcome> = {};
    const terminalGames: Game[] = [...includedGames];
    for (let i = remaining.length - 1; i >= 0; i--) {
      const game = remaining[i]!;
      const outcome = variableOutcomes[Number(value % BigInt(variableOutcomes.length))]!;
      value /= BigInt(variableOutcomes.length);
      outcomes[game.id] = outcome;
      terminalGames[includedGames.indexOf(game)] = { ...game, completed: true, status: "completed",
        homeScore: outcome === "away" ? 0 : 1, awayScore: outcome === "home" ? 0 : 1 };
    }
    const terminal: SeasonGames = { season, teams, games: terminalGames };
    const computed = computeEligibility(terminal);
    const eligible = [...computed].filter(([, entry]) => entry.eligible).map(([id]) => id).sort(codepoint);
    const ratings = computeColley(terminal);
    const recordList: SelectionInput["records"] = [...computed].map(([teamId, entry]) => ({ teamId, record: entry.record }));
    const automatic = computePlayoff({ ...terminal, ratings, records: recordList, pollEntries: [] }, snapshot)
      .seeding.selection;
    const selected = new Set([...automatic.initialBid, ...automatic.initialPlayin]);
    const candidates = eligible.filter(id => !selected.has(id));
    const count = Math.min(Math.max(0, 12 - selected.size), candidates.length);
    const pollCount = choose(candidates.length, count);
    if (BigInt(progress.pollIndex) >= pollCount) throw new Error("Unverified scenario checkpoint poll cursor");
    while (BigInt(progress.pollIndex) < pollCount && evaluatedCompletions < maxCompletions &&
      Date.now() - started < maxRuntimeMs && !unsupportedReason) {
      const chosen = subsetAt(candidates, count, BigInt(progress.pollIndex));
      const chosenSet = new Set(chosen);
      const pollOrder = [...chosen, ...eligible.filter(id => !chosenSet.has(id))].slice(0, 25);
      // A leaf commits only after all per-team poll-path memory is reserved.
      const winOutIds = fbs.filter(teamId => remaining.every(game =>
        game.homeTeamId !== teamId && game.awayTeamId !== teamId ||
        outcomes[game.id] === (game.homeTeamId === teamId ? "home" : "away")));
      const newPaths = winOutIds.filter(id => !progress.pollPairs[id]![progress.gameIndex]).length;
      if (trackedPaths + newPaths > maxTrackedPollPaths) {
        unsupportedReason = `Poll-path memory budget ${maxTrackedPollPaths} exhausted; increase the cap to resume`;
        break;
      }
      const bracket = computePlayoff({ ...terminal, ratings, records: recordList,
        pollEntries: pollOrder.map((teamId, index) => ({ teamId, rank: index + 1 })) }, snapshot);
      const qualified = new Set([...bracket.seeding.selection.bid, ...bracket.seeding.selection.playin]);
      const winOutSet = new Set(winOutIds);
      // Reserve a conservative upper bound BEFORE mutating the certified
      // accumulator. A stopped leaf is retried at the same indexed position.
      const witnessSize = new TextEncoder().encode(JSON.stringify({ kind: "qualifying_win_out",
        gameOutcomes: outcomes, pollOrderTeamIds: pollOrder,
        assumptions: ["one possible path, not a sufficient or necessary condition",
          `eligible poll order: ${pollOrder.join(" > ") || "empty"}`] })).length + 64;
      const newWitnesses = fbs.reduce((n, id) => {
        const qualifies = qualified.has(id), winOut = winOutSet.has(id);
        return n + Number(!progress.witnesses[id]![qualifies ? "qualifying" : "failing"]) +
          Number(winOut && !progress.witnesses[id]![qualifies ? "qualifying_win_out" : "failing_win_out"]);
      }, 0);
      const newPairValues = winOutIds.filter(id => !progress.pollPairs[id]![progress.gameIndex]?.[
        qualified.has(id) ? "qualifying" : "failing"]).length;
      if (frontierBytes + (newWitnesses + newPairValues) * witnessSize + 128 > maxCheckpointBytes) {
        unsupportedReason = `Checkpoint memory budget ${maxCheckpointBytes} bytes exhausted; increase the cap to resume`;
        break;
      }
      for (const teamId of fbs) {
        const qualifies = qualified.has(teamId), winOut = winOutSet.has(teamId);
        const kinds: WitnessKind[] = [qualifies ? "qualifying" : "failing"];
        if (winOut) kinds.push(qualifies ? "qualifying_win_out" : "failing_win_out");
        const witness: ScenarioWitness = { kind: kinds[0]!, gameOutcomes: { ...outcomes },
          pollOrderTeamIds: [...pollOrder], assumptions: ["one possible path, not a sufficient or necessary condition",
            `eligible poll order: ${pollOrder.join(" > ") || "empty"}`] };
        for (const kind of kinds) progress.witnesses[teamId]![kind] ??= { ...witness, kind };
        if (winOut) progress.pollPairs[teamId]![progress.gameIndex] ??= {};
        if (winOut) progress.pollPairs[teamId]![progress.gameIndex]![qualifies ? "qualifying" : "failing"] ??= witness;
      }
      progress.pollIndex = (BigInt(progress.pollIndex) + 1n).toString();
      trackedPaths += newPaths;
      // Conservatively charge each inserted witness/pair, including JSON keys
      // and cursor growth; avoid serializing the entire frontier per leaf.
      frontierBytes += (newWitnesses + newPairValues) * witnessSize + 128;
      progress.evaluated++;
      evaluatedCompletions++;
    }
    if (BigInt(progress.pollIndex) === pollCount) {
      progress.gameIndex = (BigInt(progress.gameIndex) + 1n).toString();
      progress.pollIndex = "0";
    }
  }
  if (BigInt(progress.gameIndex) < totalGames) return pending(unsupportedReason ?? pendingReason ??
    (evaluatedCompletions >= maxCompletions ? `Scenario completion budget ${maxCompletions} exhausted` :
      "Scenario runtime budget exhausted"));
  const proofs: ScenarioProof[] = fbs.map(teamId => {
    if (recordEliminated.has(teamId)) return makeProof(teamId, "");
    const found = progress.witnesses[teamId]!;
    const qualifying = Boolean(found.qualifying), failing = Boolean(found.failing);
    const winQualifying = Boolean(found.qualifying_win_out), winFailing = Boolean(found.failing_win_out);
    const label = !failing ? "clinched" : !qualifying ? "eliminated" :
      !winFailing ? "controls_destiny" : winQualifying ? "needs_help" : null;
    const state = label ? "proved" : "unsupported";
    const pollPair = label === "needs_help" ? Object.values(progress.pollPairs[teamId]!)
      .find(pair => pair.qualifying && pair.failing) : undefined;
    if (pollPair?.qualifying && pollPair.failing) {
      found.qualifying_win_out = { ...pollPair.qualifying, kind: "qualifying_win_out" };
      found.failing_win_out = { ...pollPair.failing, kind: "failing_win_out" };
    }
    return { ...base, teamId, state, label, assumptions,
      proofMetadata: JSON.stringify({ certificate: "exhaustive indexed poll-equivalence classes",
        evaluatedCompletions: progress.evaluated, scheduleFingerprint, snapshotInputHash: snapshot.inputHash,
        fixedScheduleGameIds: remaining.map(game => game.id), pollDependent: Boolean(pollPair),
        exception: label ? null : "qualifies only outside winning-out completions; policy/model review required" }),
      runtimeMs: Date.now() - started,
      witnesses: KINDS.flatMap(kind => found[kind] ? [found[kind]!] : []) };
  });
  return { proofs, assumptions, evaluatedCompletions, possibleCompletions: progress.evaluated,
    pendingReason: null, unsupportedReason: null, nextCompletion: progress.evaluated, complete: true, checkpoint: null };
}

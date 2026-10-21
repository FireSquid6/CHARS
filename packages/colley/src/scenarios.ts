import { calculateSelection } from "./index";
import { calculateRecords } from "./rating";
import type { Game, Poll, Snapshot } from "./types";

export interface Witness {
  games: { gameId: string; outcome: "home" | "away" | "tie" }[];
  poll: string[];
  qualified: boolean;
}
export interface TeamProof {
  teamId: string;
  status: "clinched" | "eliminated" | "controls_destiny" | "needs_help" | null;
  proofState: "proved" | "pending" | "incomplete" | "policy_exception";
  witnesses: { qualifies?: Witness; fails?: Witness; winOutQualifies?: Witness; winOutFails?: Witness };
}
export interface ScenarioResult {
  model: "conservative-eligible-poll-1" | "frozen-poll-1";
  assumption: string; inputHash: string; evaluated: number; exhausted: boolean; teams: TeamProof[];
}

/** Exhaustive for small inputs. Budget exhaustion never proves an absence of witnesses. */
export function analyzeScenarios(
  snapshot: Snapshot,
  remainingSchedule: Game[] = snapshot.remaining,
  pollModel: { type: "conservative" } | { type: "frozen"; poll: Poll } = { type: "conservative" },
  budget: { maxCompletions: number } = { maxCompletions: 10000 },
): ScenarioResult {
  if (!Number.isSafeInteger(budget.maxCompletions) || budget.maxCompletions < 1) throw new Error("Positive completion budget required");
  const model = pollModel.type === "conservative" ? "conservative-eligible-poll-1" : "frozen-poll-1";
  const teams: TeamProof[] = snapshot.input.teams.filter(t => t.fbs).map(t => ({ teamId: t.id, status: null, proofState: snapshot.complete ? "pending" : "incomplete", witnesses: {} }));
  const result: ScenarioResult = { model, assumption: "Fixed remaining schedule; no new games or cancellations. Ties only where tiesAllowed is true. Frozen polls give conditional, not unconditional, proofs.", inputHash: snapshot.inputHash, evaluated: 0, exhausted: false, teams };
  if (!snapshot.complete) return result;
  const remaining = [...remainingSchedule].sort((a, b) => a.id.localeCompare(b.id));
  if (remaining.some(g => !snapshot.remaining.some(r => r.id === g.id)) || remaining.length !== snapshot.remaining.length || new Set(remaining.map(g => g.id)).size !== remaining.length) throw new Error("Remaining schedule must match snapshot");
  const fixed = calculateRecords(snapshot);
  const maxWins = new Map(fixed.map(r => [r.teamId, r.wins + remaining.filter(g => g.home === r.teamId || g.away === r.teamId).length]));
  const total = new Map(fixed.map(r => [r.teamId, r.gamesPlayed + remaining.filter(g => g.home === r.teamId || g.away === r.teamId).length]));
  const impossible = new Set(teams.filter(t => 4 * maxWins.get(t.teamId)! + 2 * fixed.find(r => r.teamId === t.teamId)!.ties < 3 * total.get(t.teamId)! || total.get(t.teamId) === 0).map(t => t.teamId));
  for (const t of teams) if (impossible.has(t.teamId)) { t.status = "eliminated"; t.proofState = "proved"; }
  const outcomes: { gameId: string; outcome: "home" | "away" | "tie" }[] = [];
  const played: Game[] = [];
  let pending = false;
  const evaluate = () => {
    const scenario: Snapshot = { ...snapshot, games: [...snapshot.games, ...played], remaining: [] };
    const eligible = calculateRecords(scenario).filter(r => r.eligible).map(r => r.teamId).sort();
    const consider = (pollIds: string[]) => {
      if (result.evaluated >= budget.maxCompletions) { pending = true; return; }
      result.evaluated++;
      const poll: Poll = pollModel.type === "frozen" ? pollModel.poll : { id: "hypothetical", year: snapshot.input.year, week: 0, releasedAt: snapshot.input.terminalCutoff, type: snapshot.input.year < 2014 ? "AP" : "CFP", entries: pollIds.map((teamId, i) => ({ teamId, rank: i + 1 })) };
      const selection = calculateSelection({ ...scenario, poll });
      const qualified = new Set(selection.final.entries.filter(e => e.category !== "outside").map(e => e.teamId));
      for (const t of teams) {
        if (impossible.has(t.teamId)) continue;
        const winOut = remaining.every((g, i) => (g.home !== t.teamId && g.away !== t.teamId) || (g.home === t.teamId ? outcomes[i].outcome === "home" : outcomes[i].outcome === "away"));
        const yes = qualified.has(t.teamId);
        const witness: Witness = { games: outcomes.map(o => ({ ...o })), poll: [...pollIds], qualified: yes };
        if (yes) { t.witnesses.qualifies ??= witness; if (winOut) t.witnesses.winOutQualifies ??= witness; }
        else { t.witnesses.fails ??= witness; if (winOut) t.witnesses.winOutFails ??= witness; }
      }
    };
    if (pollModel.type === "frozen") { consider(pollModel.poll.entries.map(e => e.teamId)); return; }
    const length = Math.min(25, eligible.length);
    const order: string[] = [], used = new Set<string>();
    const polls = () => {
      if (pending) return;
      if (order.length === length) { consider(order); return; }
      for (const id of eligible) {
        if (used.has(id)) continue;
        used.add(id); order.push(id); polls(); order.pop(); used.delete(id);
        if (pending) return;
      }
    };
    polls();
  };
  const enumerate = (i: number) => {
    if (pending) return;
    if (i === remaining.length) { evaluate(); return; }
    const g = remaining[i];
    for (const outcome of (["home", "away", ...(g.tiesAllowed ? ["tie"] : [])] as ("home" | "away" | "tie")[])) {
      outcomes.push({ gameId: g.id, outcome });
      played.push({ ...g, status: "completed", completedAt: g.scheduledAt, homeScore: outcome === "home" ? 1 : 0, awayScore: outcome === "away" ? 1 : 0 });
      enumerate(i + 1);
      outcomes.pop(); played.pop();
      if (pending) return;
    }
  };
  enumerate(0);
  result.exhausted = !pending;
  for (const t of teams) {
    if (t.proofState === "proved") continue;
    const w = t.witnesses;
    if (!w.fails) { if (!pending) { t.status = "clinched"; t.proofState = "proved"; } }
    else if (!w.qualifies) { if (!pending) { t.status = "eliminated"; t.proofState = "proved"; } }
    else if (!w.winOutFails) { if (!pending) { t.status = "controls_destiny"; t.proofState = "proved"; } }
    else if (w.winOutQualifies) { t.status = "needs_help"; t.proofState = "proved"; }
    else if (!pending) t.proofState = "policy_exception";
  }
  return result;
}

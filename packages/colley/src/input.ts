import { createHash } from "node:crypto";
import type { Game, Input, Poll, Snapshot } from "./types";

const date = (s: string) => Number.isFinite(Date.parse(s)) && new Date(s).toISOString() === s;
function assert(ok: unknown, message: string): asserts ok { if (!ok) throw new Error(message); }

export function validateInput(input: Input): Input {
  assert(Number.isInteger(input.year), "Invalid season");
  assert(date(input.terminalCutoff), "Invalid terminal cutoff (ISO timestamp required)");
  assert(Array.isArray(input.teams) && Array.isArray(input.games) && Array.isArray(input.polls), "Missing collections");
  assert(typeof input.membershipComplete === "boolean" && typeof input.scheduleComplete === "boolean" && typeof input.pollsComplete === "boolean", "Completeness assertions required");
  const teams = new Map<string, boolean>();
  for (const t of input.teams) {
    assert(typeof t.id === "string" && t.id.length > 0 && typeof t.name === "string" && t.name.length > 0 && typeof t.fbs === "boolean" && !teams.has(t.id), `Invalid/duplicate team: ${t.id}`);
    teams.set(t.id, t.fbs);
  }
  const games = new Map<string, Game>();
  for (const g of input.games) {
    assert(typeof g.id === "string" && g.id.length > 0 && g.year === input.year && Number.isInteger(g.week), `Invalid game identity: ${g.id}`);
    assert(teams.has(g.home) && teams.has(g.away) && g.home !== g.away, `Invalid opponents: ${g.id}`);
    assert(["regular", "ccg", "bowl", "playoff"].includes(g.kind) && ["completed", "scheduled", "cancelled"].includes(g.status) && date(g.scheduledAt), `Invalid game metadata: ${g.id}`);
    if (g.status === "completed") assert(date(g.completedAt ?? "") && Number.isSafeInteger(g.homeScore) && Number.isSafeInteger(g.awayScore) && (g.homeScore ?? -1) >= 0 && (g.awayScore ?? -1) >= 0, `Invalid result: ${g.id}`);
    else assert(g.homeScore === null && g.awayScore === null && !g.completedAt, `Unplayed game has a result: ${g.id}`);
    assert(!games.has(g.id) || JSON.stringify(games.get(g.id)) === JSON.stringify(g), `Conflicting duplicate game: ${g.id}`);
    games.set(g.id, g);
  }
  const polls = new Map<string, Poll>();
  for (const p of input.polls) {
    assert(p.year === input.year && Number.isInteger(p.week) && date(p.releasedAt) && ["AP", "CFP"].includes(p.type) && p.id.length > 0, `Invalid poll: ${p.id}`);
    const ids = new Set<string>();
    for (const e of p.entries) {
      assert(teams.get(e.teamId) === true && Number.isInteger(e.rank) && e.rank > 0 && !ids.has(e.teamId), `Invalid poll entry: ${p.id}/${e.teamId}`);
      ids.add(e.teamId);
    }
    assert(!polls.has(p.id), `Duplicate poll: ${p.id}`);
    polls.set(p.id, p);
  }
  return { ...input, games: [...games.values()] };
}

export function buildSnapshot(input: Input, cutoff: string, associatedPollId?: string): Snapshot {
  input = validateInput(input);
  if (!date(cutoff) || cutoff > input.terminalCutoff) throw new Error("Snapshot cutoff must be ISO and no later than terminal cutoff");
  const games = input.games.filter(g => g.kind === "regular" && g.status === "completed" && g.completedAt! <= cutoff && g.scheduledAt <= input.terminalCutoff).sort((a, b) => a.id.localeCompare(b.id));
  const remaining = input.games.filter(g => g.kind === "regular" && g.status !== "cancelled" && !(g.status === "completed" && g.completedAt! <= cutoff) && g.scheduledAt <= input.terminalCutoff).map(g => ({ ...g, status: "scheduled" as const, completedAt: undefined, homeScore: null, awayScore: null })).sort((a, b) => a.id.localeCompare(b.id));
  const eligiblePolls = input.polls.filter(p => p.releasedAt <= cutoff);
  const type = input.year < 2014 || !eligiblePolls.some(p => p.type === "CFP") ? "AP" : "CFP";
  const poll = associatedPollId ? input.polls.find(p => p.id === associatedPollId) ?? null : eligiblePolls.filter(p => p.type === type).sort((a, b) => b.releasedAt.localeCompare(a.releasedAt) || b.id.localeCompare(a.id))[0] ?? null;
  if (associatedPollId && !poll) throw new Error(`Associated poll ${associatedPollId} was not supplied`);
  const missing = [!input.membershipComplete && "membership", !input.scheduleComplete && "schedule", !input.pollsComplete && "polls", !poll && "associated poll", remaining.some(g => g.scheduledAt <= cutoff) && "unresolved games before cutoff"].filter((v): v is string => typeof v === "string");
  const canonical = JSON.stringify({ ...input, teams: [...input.teams].sort((a, b) => a.id.localeCompare(b.id)), games: [...input.games].sort((a, b) => a.id.localeCompare(b.id)), polls: [...input.polls].sort((a, b) => a.id.localeCompare(b.id)) });
  return { input, cutoff, games, remaining, poll, pollFallback: input.year >= 2014 && poll?.type === "AP", complete: missing.length === 0, missing, inputHash: createHash("sha256").update(canonical).digest("hex"), policyVersion: "colley-fbs-1" };
}

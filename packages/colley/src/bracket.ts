import type { Bracket, Field, Graph, Ratings, Seed } from "./types";

export function seedSelectedTeams(field: Field, graph: Graph, ratings: Ratings): Seed[] {
  const selected = field.entries.slice(0, field.bidCount + field.playinCount);
  const ids = new Set(selected.map(e => e.teamId));
  const edges = graph.active.filter(e => ids.has(e.winner) && ids.has(e.loser)).map(e => [e.winner, e.loser] as const);
  for (const cycle of graph.cycles) {
    const members = cycle.filter(id => ids.has(id)).sort(ratings.compare);
    for (let i = 1; i < members.length; i++) edges.push([members[i - 1], members[i]]);
  }
  const remaining = new Set(ids), order: string[] = [];
  while (remaining.size) {
    const available = [...remaining].filter(id => !edges.some(([from, to]) => to === id && remaining.has(from))).sort(ratings.compare);
    if (!available.length) throw new Error("Seeding constraints are cyclic");
    const id = available[0]; order.push(id); remaining.delete(id);
  }
  const byId = new Map(field.entries.map(e => [e.teamId, e]));
  const byRating = new Map(ratings.entries.map(r => [r.teamId, r]));
  return order.map((teamId, i) => ({ teamId, adjustedRank: i + 1, rawRank: byRating.get(teamId)!.rawRank, rating: byRating.get(teamId)!.rating, category: byId.get(teamId)!.category, route: byId.get(teamId)!.route }));
}

export function buildPlayInsAndBracket(field: Field, adjustedOrder: Seed[]): Bracket {
  const playins = adjustedOrder.filter(e => e.category === "playin");
  const playInBye = playins.length % 2 ? playins.shift()!.teamId : null;
  const pairs: [string, string][] = [];
  while (playins.length) pairs.push([playins.shift()!.teamId, playins.pop()!.teamId]);
  const rank = new Map(adjustedOrder.map(e => [e.teamId, e.adjustedRank]));
  const provisional = [...adjustedOrder.filter(e => e.category === "bid").map(e => [e.teamId]), ...(playInBye ? [[playInBye]] : []), ...pairs];
  provisional.sort((a, b) => rank.get(a[0])! - rank.get(b[0])!);
  const slots = provisional.map((alternatives, i) => ({ seed: i + 1, alternatives }));
  const n = slots.length;
  let placement = [1, 2];
  while (placement.length < Math.max(2, n)) {
    const size = placement.length * 2;
    placement = placement.flatMap(seed => [seed, size + 1 - seed]);
  }
  const firstRound: [number | null, number | null][] = n < 2 ? [] : [];
  for (let i = 0; i < placement.length && n > 1; i += 2) firstRound.push([placement[i] <= n ? placement[i] : null, placement[i + 1] <= n ? placement[i + 1] : null]);
  // Only uncontested byes advance automatically; contested games remain unresolved.
  const rounds = [firstRound];
  let previous = firstRound;
  while (previous.length > 1) {
    const advances = previous.map(([a, b]) => a === null ? b : b === null ? a : null);
    const next: [number | null, number | null][] = [];
    for (let i = 0; i < advances.length; i += 2) next.push([advances[i], advances[i + 1]]);
    rounds.push(next);
    previous = next;
  }
  return { playInBye, pairs, slots, size: n === 1 ? 1 : n ? placement.length : 0, firstRound, rounds: n < 2 ? [] : rounds };
}

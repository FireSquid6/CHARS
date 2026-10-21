import type { Edge, Field, FieldEntry, Graph, Poll, Ratings, RecordResult, Snapshot, SwapEvent, Category } from "./types";

export function selectInitialField(snapshot: Snapshot, ratings: Ratings, poll: Poll | null = snapshot.poll): Field {
  const eligible = new Set(calculateEligible(snapshot, ratings));
  const order = ratings.entries.map(r => r.teamId).filter(id => eligible.has(id));
  const routes = new Map<string, FieldEntry>(order.map(teamId => [teamId, { teamId, category: "outside", route: "outside" }]));
  const add = (id: string, category: Category, route: FieldEntry["route"]) => { routes.set(id, { teamId: id, category, route }); };
  for (const id of order) if (ratings.atLeast(id, ".90")) add(id, "bid", "rating_bid");
  for (const id of order) if ([...routes.values()].filter(e => e.category === "bid").length < 4 && routes.get(id)!.category === "outside") add(id, "bid", "colley_minimum_bid");
  for (const id of order) if (routes.get(id)!.category === "outside" && ratings.atLeast(id, ".85")) add(id, "playin", "rating_playin");
  const ranked = [...(poll?.entries ?? [])].sort((a, b) => a.rank - b.rank || ratings.compare(a.teamId, b.teamId));
  for (const { teamId } of ranked) {
    if ([...routes.values()].filter(e => e.category !== "outside").length >= 12) break;
    if (routes.get(teamId)?.category === "outside") add(teamId, "playin", "poll_playin");
  }
  const entries = (["bid", "playin", "outside"] as const).flatMap(category => order.filter(id => routes.get(id)!.category === category).map(id => routes.get(id)!));
  return { entries, bidCount: entries.filter(e => e.category === "bid").length, playinCount: entries.filter(e => e.category === "playin").length, swaps: [], unapplied: [] };
}

function calculateEligible(snapshot: Snapshot, ratings: Ratings): string[] {
  // Records are recomputed from the snapshot, not inferred from rating inputs.
  const records = calculateRecords(snapshot);
  return records.filter(r => r.eligible && ratings.entries.some(e => e.teamId === r.teamId)).map(r => r.teamId);
}
import { calculateRecords } from "./rating";

export function buildHeadToHead(snapshot: Snapshot): Graph {
  const ids = snapshot.input.teams.filter(t => t.fbs).map(t => t.id).sort();
  const fbs = new Set(ids);
  const series = new Map<string, { wins: string[]; losses: string[]; ties: boolean }>();
  for (const g of snapshot.games) {
    if (!fbs.has(g.home) || !fbs.has(g.away)) continue;
    const [a, b] = [g.home, g.away].sort();
    const key = `${a}\0${b}`;
    const s = series.get(key) ?? { wins: [], losses: [], ties: false };
    if (g.homeScore === g.awayScore) s.ties = true;
    else if ((g.home === a) === (g.homeScore! > g.awayScore!)) s.wins.push(g.id);
    else s.losses.push(g.id);
    series.set(key, s);
  }
  const raw: Edge[] = [];
  for (const [key, s] of series) {
    if (s.ties || Boolean(s.wins.length) === Boolean(s.losses.length)) continue;
    const [a, b] = key.split("\0");
    raw.push(s.wins.length ? { winner: a, loser: b, gameIds: s.wins.sort() } : { winner: b, loser: a, gameIds: s.losses.sort() });
  }
  raw.sort((a, b) => a.winner.localeCompare(b.winner) || a.loser.localeCompare(b.loser));
  const adjacency = new Map(ids.map(id => [id, raw.filter(e => e.winner === id).map(e => e.loser)]));
  let step = 0;
  const index = new Map<string, number>(), low = new Map<string, number>(), stack: string[] = [], on = new Set<string>(), cycles: string[][] = [];
  const visit = (id: string) => {
    index.set(id, step); low.set(id, step++); stack.push(id); on.add(id);
    for (const to of adjacency.get(id)!) {
      if (!index.has(to)) { visit(to); low.set(id, Math.min(low.get(id)!, low.get(to)!)); }
      else if (on.has(to)) low.set(id, Math.min(low.get(id)!, index.get(to)!));
    }
    if (low.get(id) === index.get(id)) {
      const group: string[] = [];
      let v: string;
      do { v = stack.pop()!; on.delete(v); group.push(v); } while (v !== id);
      if (group.length > 1) cycles.push(group.sort());
    }
  };
  for (const id of ids) if (!index.has(id)) visit(id);
  cycles.sort((a, b) => a[0].localeCompare(b[0]));
  const component = new Map(cycles.flatMap((group, i) => group.map(id => [id, i] as const)));
  const suppressed = raw.filter(e => component.has(e.winner) && component.get(e.winner) === component.get(e.loser));
  return { raw, active: raw.filter(e => !suppressed.includes(e)), suppressed, cycles };
}

export function applyCategorySwaps(initial: Field, graph: Graph, ratings: Ratings): Field {
  const list = initial.entries.map(e => ({ ...e }));
  const swaps: SwapEvent[] = [];
  const seen = new Set<string>();
  const category = (pos: number): Category => pos < initial.bidCount ? "bid" : pos < initial.bidCount + initial.playinCount ? "playin" : "outside";
  for (;;) {
    const state = list.map(e => e.teamId).join("\0");
    if (seen.has(state)) throw new Error("Swap state repeated");
    seen.add(state);
    const positions = new Map(list.map((e, i) => [e.teamId, i]));
    const options = graph.active.flatMap(edge => {
      const w = positions.get(edge.winner), l = positions.get(edge.loser);
      if (w === undefined || l === undefined) return [];
      const from = category(w), to = category(l);
      return (from === "playin" && to === "bid") || (from === "outside" && to === "playin") ? [{ edge, w, l, priority: from === "playin" ? 0 : 1 }] : [];
    });
    options.sort((a, b) => a.priority - b.priority || a.l - b.l || ratings.compare(a.edge.winner, b.edge.winner) || a.edge.loser.localeCompare(b.edge.loser));
    if (!options.length) {
      const unapplied = graph.active.filter(e => category(positions.get(e.winner) ?? list.length) === "outside" && category(positions.get(e.loser) ?? list.length) === "bid" && positions.has(e.winner) && positions.has(e.loser));
      return { entries: list, bidCount: initial.bidCount, playinCount: initial.playinCount, swaps, unapplied };
    }
    const { edge, w, l } = options[0];
    const winnerFrom = category(w), loserFrom = category(l);
    [list[w], list[l]] = [list[l], list[w]];
    list[w].category = winnerFrom; list[l].category = loserFrom;
    swaps.push({ winner: edge.winner, loser: edge.loser, gameIds: edge.gameIds, winnerFrom, loserFrom, winnerTo: loserFrom, loserTo: winnerFrom });
  }
}

import { includedRegularGames, type SeasonGames } from "./eligibility";

const compareIds = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;

export interface HeadToHeadEdge {
  winnerTeamId: string;
  loserTeamId: string;
  supportingGameIds: string[];
}

export interface HeadToHeadGraph {
  rawEdges: HeadToHeadEdge[];
  suppressedEdges: HeadToHeadEdge[];
  activeEdges: HeadToHeadEdge[];
  /** All FBS vertices, including singletons and ineligible teams. */
  components: string[][];
  cyclicComponents: string[][];
}

export function buildHeadToHead(input: SeasonGames): HeadToHeadGraph {
  const ids = input.teams.filter(team => team.membership === "fbs").map(team => team.teamId).sort();
  const vertices = new Set(ids);
  const meetings = new Map<string, { first: string; second: string; firstWins: string[];
    secondWins: string[]; tied: boolean }>();
  for (const game of includedRegularGames(input)) {
    if (!vertices.has(game.homeTeamId) || !vertices.has(game.awayTeamId)) continue;
    const [first, second] = [game.homeTeamId, game.awayTeamId].sort();
    const key = JSON.stringify([first, second]);
    let series = meetings.get(key);
    if (!series) {
      series = { first: first!, second: second!, firstWins: [], secondWins: [], tied: false };
      meetings.set(key, series);
    }
    if (game.homeScore === game.awayScore) series.tied = true;
    else if ((game.homeScore > game.awayScore) === (game.homeTeamId === first)) series.firstWins.push(game.id);
    else series.secondWins.push(game.id);
  }
  const rawEdges: HeadToHeadEdge[] = [];
  for (const series of meetings.values()) {
    if (series.tied || (series.firstWins.length && series.secondWins.length)) continue;
    if (series.firstWins.length) rawEdges.push({ winnerTeamId: series.first,
      loserTeamId: series.second, supportingGameIds: series.firstWins.sort() });
    if (series.secondWins.length) rawEdges.push({ winnerTeamId: series.second,
      loserTeamId: series.first, supportingGameIds: series.secondWins.sort() });
  }
  rawEdges.sort((a, b) => compareIds(a.winnerTeamId, b.winnerTeamId) ||
    compareIds(a.loserTeamId, b.loserTeamId));
  const outgoing = new Map(ids.map(id => [id, [] as string[]]));
  for (const edge of rawEdges) outgoing.get(edge.winnerTeamId)!.push(edge.loserTeamId);
  const discovery = new Map<string, number>(), low = new Map<string, number>();
  const stack: string[] = [], onStack = new Set<string>(), components: string[][] = [];
  function visit(id: string): void {
    const number = discovery.size;
    discovery.set(id, number);
    low.set(id, number);
    stack.push(id);
    onStack.add(id);
    for (const next of outgoing.get(id)!) {
      if (!discovery.has(next)) {
        visit(next);
        low.set(id, Math.min(low.get(id)!, low.get(next)!));
      } else if (onStack.has(next)) low.set(id, Math.min(low.get(id)!, discovery.get(next)!));
    }
    if (low.get(id) === discovery.get(id)) {
      const component: string[] = [];
      let member: string;
      do {
        member = stack.pop()!;
        onStack.delete(member);
        component.push(member);
      } while (member !== id);
      components.push(component.sort());
    }
  }
  for (const id of ids) if (!discovery.has(id)) visit(id);
  components.sort((a, b) => compareIds(a[0]!, b[0]!));
  const cyclicComponents = components.filter(component => component.length > 1);
  const componentById = new Map(components.flatMap((component, i) => component.map(id => [id, i] as const)));
  const suppressedEdges = rawEdges.filter(edge => componentById.get(edge.winnerTeamId) === componentById.get(edge.loserTeamId));
  const activeEdges = rawEdges.filter(edge => componentById.get(edge.winnerTeamId) !== componentById.get(edge.loserTeamId));
  return { rawEdges, suppressedEdges, activeEdges, components, cyclicComponents };
}

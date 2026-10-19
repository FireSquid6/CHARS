import type { Game, RecordStats, TeamSeason } from "./index";

export interface SeasonGames {
  /** Declared football season for every membership and game, including excluded fixtures. */
  season: number;
  /** Season-scoped membership, including FCS opponents in the supplied snapshot. */
  teams: readonly TeamSeason[];
  /** Snapshot-scoped games: the caller must enforce its declared time cutoff. */
  games: readonly Game[];
}

export interface IncludedGame {
  id: string;
  homeTeamId: string;
  awayTeamId: string;
  homeScore: number;
  awayScore: number;
  homeMembership: TeamSeason["membership"];
  awayMembership: TeamSeason["membership"];
}

export function includedRegularGames(input: SeasonGames): IncludedGame[] {
  if (!Number.isSafeInteger(input.season) || input.season < 1) throw new Error("Invalid declared season");
  const membership = new Map<string, TeamSeason>();
  const seenGames = new Set<string>();
  const seenProviderGames = new Set<string>();
  for (const team of input.teams) {
    if (team.season !== input.season) throw new Error(`Wrong-season team ${team.teamId}: expected ${input.season}`);
    if (!team.teamId || membership.has(team.teamId)) throw new Error(`Duplicate/empty team ID: ${team.teamId}`);
    membership.set(team.teamId, team);
  }
  const included: IncludedGame[] = [];
  for (const game of input.games) {
    if (game.season !== input.season) throw new Error(`Wrong-season game ${game.id}: expected ${input.season}`);
    if (!game.id || seenGames.has(game.id)) throw new Error(`Duplicate/empty game ID: ${game.id}`);
    seenGames.add(game.id);
    if (!game.providerGameId || seenProviderGames.has(game.providerGameId)) {
      throw new Error(`Duplicate/empty provider game ID: ${game.providerGameId}`);
    }
    seenProviderGames.add(game.providerGameId);
    if (game.homeTeamId === game.awayTeamId) throw new Error(`Identical opponents in ${game.id}`);
    const home = membership.get(game.homeTeamId);
    const away = membership.get(game.awayTeamId);
    if (!home || !away || home.season !== game.season || away.season !== game.season) {
      throw new Error(`Unknown or wrong-season opponent in ${game.id}`);
    }
    if (game.completed !== (game.status === "completed")) throw new Error(`Inconsistent completion in ${game.id}`);
    if (game.completed && (!Number.isSafeInteger(game.homeScore) || !Number.isSafeInteger(game.awayScore) ||
      game.homeScore! < 0 || game.awayScore! < 0)) throw new Error(`Invalid completed score in ${game.id}`);
    if (!game.completed || game.applicationGameType !== "regular") continue;
    included.push({ id: game.id, homeTeamId: game.homeTeamId, awayTeamId: game.awayTeamId,
      homeScore: game.homeScore!, awayScore: game.awayScore!, homeMembership: home.membership,
      awayMembership: away.membership });
  }
  return included;
}

/** Collision-free canonical identity for the season's memberships and included outcomes. */
export function colleyInputFingerprint(input: SeasonGames): string {
  const games = includedRegularGames(input)
    .map(game => [game.id, game.homeTeamId, game.awayTeamId, game.homeScore, game.awayScore] as const)
    .sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  const teams = input.teams.map(team => [team.teamId, team.membership] as const)
    .sort((a, b) => a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0);
  return JSON.stringify([input.season, teams, games]);
}

export function recordIsEligible(record: Pick<RecordStats, "wins" | "losses" | "ties">): boolean {
  const { wins, losses, ties } = record;
  if (![wins, losses, ties].every(value => Number.isSafeInteger(value) && value >= 0)) {
    throw new Error("Invalid record");
  }
  const games = wins + losses + ties;
  if (!Number.isSafeInteger(games)) throw new Error("Record exceeds safe integer range");
  return games > 0 && 4n * BigInt(wins) + 2n * BigInt(ties) >= 3n * BigInt(games);
}

export function computeEligibility(input: SeasonGames): Map<string, { record: RecordStats; eligible: boolean }> {
  const records = new Map<string, { wins: number; losses: number; ties: number }>();
  for (const team of input.teams) if (team.membership === "fbs") {
    if (records.has(team.teamId)) throw new Error(`Duplicate FBS team ${team.teamId}`);
    records.set(team.teamId, { wins: 0, losses: 0, ties: 0 });
  }
  for (const game of includedRegularGames(input)) {
    const home = records.get(game.homeTeamId), away = records.get(game.awayTeamId);
    if (home && !away && game.awayMembership !== "fcs") continue;
    if (away && !home && game.homeMembership !== "fcs") continue;
    if (game.homeScore === game.awayScore) {
      if (home) home.ties++;
      if (away) away.ties++;
    } else if (game.homeScore > game.awayScore) {
      if (home) home.wins++;
      if (away) away.losses++;
    } else {
      if (home) home.losses++;
      if (away) away.wins++;
    }
  }
  return new Map([...records].map(([id, counts]) => {
    const games = counts.wins + counts.losses + counts.ties;
    const record: RecordStats = { ...counts, percentageNumerator: 2 * counts.wins + counts.ties,
      percentageDenominator: 2 * games };
    return [id, { record, eligible: recordIsEligible(counts) }];
  }));
}

import type { Game, Membership, Team } from "./index";

const knownAliases: Record<string, string[]> = {
  "Southern California": ["USC", "Southern Cal"],
  "Miami": ["Miami (FL)", "Miami FL"],
  "Miami (OH)": ["Miami OH", "Miami Ohio"]
};
function key(name: string): string { return name.trim().toLowerCase().replace(/\s+/g, " "); }
export type Identity = { id: string; providerId: string; name: string; membership: Membership; conference: string | null; season: number };

/** Provider ID is authoritative. Names alone are never used to join games with known IDs. */
export function createTeamResolver(teams: readonly Team[], games: readonly Game[] = []) {
  const byId = new Map<string, Identity>();
  const byAlias = new Map<string, string | null>();
  function alias(name: string, id: string) {
    const normalized = key(name);
    if (!normalized) return;
    const old = byAlias.get(normalized);
    byAlias.set(normalized, old === undefined ? id : old === id ? id : null);
  }
  for (const team of teams) {
    if (byId.has(team.id)) throw new Error(`Duplicate CFBD team ID ${team.id}`);
    byId.set(team.id, { id: `cfbd:${team.id}`, providerId: team.id, name: team.school,
      membership: team.membership, conference: team.conference, season: team.season });
    for (const name of [team.school, team.abbreviation, ...team.alternateNames, ...knownAliases[team.school] ?? []]) {
      if (name) alias(name, team.id);
    }
  }
  for (const game of games) {
    for (const side of [
      { id: game.homeId, name: game.homeTeam, classification: game.homeClassification },
      { id: game.awayId, name: game.awayTeam, classification: game.awayClassification }
    ]) {
      if (byId.has(side.id)) continue;
      if (side.classification?.toLowerCase() === "fbs") throw new Error(`Missing season FBS roster entry ${side.id}`);
      byId.set(side.id, { id: `cfbd:${side.id}`, providerId: side.id, name: side.name, season: game.season,
        membership: side.classification?.toLowerCase() === "fcs" ? "fcs" : "other", conference: null });
      alias(side.name, side.id);
    }
  }
  return {
    byProviderId(id: string): Identity {
      const team = byId.get(id);
      if (!team) throw new Error(`Unknown CFBD team ID ${id}; season roster incomplete`);
      return team;
    },
    byName(name: string): Identity {
      const id = byAlias.get(key(name));
      if (id === null) throw new Error(`Ambiguous CFBD team alias ${name}`);
      if (id === undefined) throw new Error(`Unknown CFBD team alias ${name}`);
      return this.byProviderId(id);
    },
    game(game: Game) {
      const home = this.byProviderId(game.homeId), away = this.byProviderId(game.awayId);
      if (home.season !== game.season || away.season !== game.season) throw new Error(`Season membership mismatch for game ${game.id}`);
      return { home, away };
    }
  };
}

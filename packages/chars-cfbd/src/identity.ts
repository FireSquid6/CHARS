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
  function checkSide(id: string, name: string, classification: string | null, season: number) {
    const known = byId.get(id);
    const sideMembership: Membership = classification === null ? "unknown" :
      classification.toLowerCase() === "fbs" ? "fbs" :
      classification.toLowerCase() === "fcs" ? "fcs" : "other";
    if (known && known.season !== season) throw new Error(`Season membership mismatch for CFBD team ${id}`);
    if (known && sideMembership !== "unknown" && known.membership !== "unknown" && known.membership !== sideMembership) {
      throw new Error(`CFBD game classification conflicts with season membership for team ${id}`);
    }
    if (known) {
      if (known.membership === "unknown" && sideMembership !== "unknown") {
        if (sideMembership === "fbs") throw new Error(`Missing season FBS roster entry ${id}`);
        known.membership = sideMembership;
      }
      return known;
    }
    if (sideMembership === "fbs") throw new Error(`Missing season FBS roster entry ${id}`);
    const identity: Identity = { id: `cfbd:${id}`, providerId: id, name, season,
      membership: sideMembership, conference: null };
    byId.set(id, identity);
    alias(name, id);
    return identity;
  }
  for (const game of games) {
    checkSide(game.homeId, game.homeTeam, game.homeClassification, game.season);
    checkSide(game.awayId, game.awayTeam, game.awayClassification, game.season);
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
      const home = checkSide(game.homeId, game.homeTeam, game.homeClassification, game.season);
      const away = checkSide(game.awayId, game.awayTeam, game.awayClassification, game.season);
      return { home, away };
    }
  };
}

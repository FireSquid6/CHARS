import { describe, expect, test } from "bun:test";
import { CfbdError, createClient, createTeamResolver, parseGames, parseRankings, parseTeams } from "../src/index";

const game = { id: 100, season: 2026, week: 0, seasonType: "regular", startDate: "2026-08-29T20:00:00Z",
  completed: false, homeId: 1, awayId: 2, homeTeam: "Southern California", awayTeam: "Miami",
  homePoints: 0, awayPoints: 0, homeClassification: "fbs", awayClassification: "fbs", notes: null, playoff: null };
const team = (id: number, school: string, classification = "fbs") => ({ id, school, classification,
  abbreviation: null, alternateNames: [], conference: "Independent" });
function mock(routes: Record<string, unknown | Response>, seen: URL[] = []) {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    seen.push(url);
    expect(init?.headers).toEqual({ Authorization: "Bearer test-key", Accept: "application/json" });
    const result = routes[url.pathname];
    return result instanceof Response ? result : Response.json(result);
  });
}

describe("schema and identity", () => {
  test("schedules and corrected scores retain full raw revision, including FCS", () => {
    const before = parseGames([game], 2026)[0]!;
    expect(before.completed).toBe(false);
    expect(before.homePoints).toBe(0);
    const after = parseGames([{ ...game, completed: true, homePoints: 21, awayPoints: 7, awayClassification: "fcs" }], 2026)[0]!;
    expect(after.id).toBe(before.id);
    expect(after.raw.awayClassification).toBe("fcs");
    expect(after.homePoints).toBe(21);
    expect(() => parseGames([{ ...game, completed: true, awayPoints: null }], 2026)).toThrow("completed without scores");
    expect(() => parseGames([{ ...game, id: 0 }], 2026)).toThrow("invalid response");
  });
  test("poll ties, unranked entries, release week and unknown publication time", () => {
    const weeks = parseRankings([{ season: 2026, seasonType: "regular", week: 7,
      polls: [{ poll: "AP Top 25", isFinal: false, ranks: [
        { rank: 12, teamId: 1, school: "Southern California", points: 100 },
        { rank: 12, teamId: 2, school: "Miami", points: 99 },
        { rank: null, teamId: 3, school: "Other", points: 1 }
      ] }] }], 2026);
    expect(weeks[0]?.polls[0]?.entries.map(e => e.rank)).toEqual([12, 12, null]);
    expect(weeks[0]?.releasedAtUtc).toBeNull();
    expect(weeks[0]?.week).toBe(7);
  });
  test("season-specific IDs disambiguate USC and both Miamis", () => {
    const roster = parseTeams([team(1, "Southern California"), team(2, "Miami"), team(3, "Miami (OH)", "fcs")], 2026, new Set(["1", "2"]));
    const resolver = createTeamResolver(roster);
    expect(resolver.byName("USC").providerId).toBe("1");
    expect(resolver.byName("Miami (FL)").providerId).toBe("2");
    expect(resolver.byName("Miami (OH)").providerId).toBe("3");
    expect(resolver.game(parseGames([game], 2026)[0]!).away.id).toBe("cfbd:2");
    expect(roster[2]?.membership).toBe("fcs");
    expect(() => resolver.byName("Miami University")).toThrow("Unknown");
  });
  test("FCS opponents absent from team roster still retain provider identity", () => {
    const fixture = parseGames([{ ...game, awayId: 40, awayTeam: "FCS Visitor", awayClassification: "fcs" }], 2026)[0]!;
    const resolver = createTeamResolver(parseTeams([team(1, "Southern California")], 2026, new Set(["1"])), [fixture]);
    expect(resolver.game(fixture).away).toMatchObject({ id: "cfbd:40", membership: "fcs" });
    expect(() => createTeamResolver([], [parseGames([game], 2026)[0]!])).toThrow("Missing season FBS roster");
  });
});

describe("HTTP boundary", () => {
  test("missing key fails before network", () => {
    const original = process.env.CFBD_API_KEY;
    delete process.env.CFBD_API_KEY;
    try { expect(() => createClient()).toThrow("CFBD_API_KEY is missing"); }
    finally { if (original !== undefined) process.env.CFBD_API_KEY = original; }
  });
  test("explicit season queries and both rosters", async () => {
    const seen: URL[] = [];
    const client = createClient({ apiKey: "test-key", fetch: mock({ "/games": [game], "/rankings": [],
      "/calendar": [{ season: 2026, week: 0, seasonType: "regular", startDate: "2026-08-27T00:00:00Z", endDate: "2026-09-03T00:00:00Z" }],
      "/teams/fbs": [team(1, "Southern California")], "/teams": [team(1, "Southern California"), team(2, "Miami", "fcs")] }, seen) });
    expect((await client.games(2026)).items[0]?.id).toBe("100");
    expect((await client.teams(2026)).items.map(t => t.membership)).toEqual(["fbs", "fcs"]);
    await client.rankings(2026);
    await client.calendar(2026);
    expect(seen.map(url => url.pathname)).toEqual(["/games", "/games", "/teams/fbs", "/teams", "/rankings", "/calendar"]);
    expect(seen[0]?.searchParams.get("classification")).toBe("fbs");
    expect(seen[1]?.searchParams.get("classification")).toBe("fcs");
    expect(seen[0]?.searchParams.get("seasonType")).toBe("both");
    expect(seen[4]?.searchParams.has("latest")).toBe(false);
    expect(seen.every(url => url.searchParams.get("year") === "2026" && !url.toString().includes("test-key"))).toBe(true);
  });
  test("bounded 429 retries honor Retry-After; no retry on authorization errors", async () => {
    let calls = 0;
    const delays: number[] = [];
    const client = createClient({ apiKey: "test-key", retries: 1, sleep: async ms => { delays.push(ms); },
      fetch: async () => ++calls === 1 ? new Response("quota", { status: 429, headers: { "retry-after": "2" } }) : Response.json([game]) });
    expect((await client.games(2026)).items).toHaveLength(1);
    expect(delays).toEqual([2000]);
    const denied = createClient({ apiKey: "test-key", fetch: mock({ "/games": new Response("secret", { status: 401 }) }) });
    await expect(denied.games(2026)).rejects.toMatchObject({ status: 401, message: "CFBD HTTP 401" });
  });
  test("rejects unexpected shape without presenting an empty successful season", async () => {
    const client = createClient({ apiKey: "test-key", fetch: mock({ "/games": { error: "bad" } }) });
    await expect(client.games(2026)).rejects.toThrow("CFBD invalid response");
  });
});

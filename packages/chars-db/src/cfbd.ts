/** Server-only CFBD boundary. No credentials in URLs, logs, or error messages. */
if (typeof globalThis === "object" && "window" in globalThis) throw new Error("CFBD client is server-only");

export type Source<T> = { url: string; observedAtUtc: string; raw: unknown; items: T[] };
export type ProviderGame = { id: number; season: number; week: number; seasonType: string; startDate: string; homeId: number; awayId: number; homeTeam: string; awayTeam: string; homePoints: number | null; awayPoints: number | null; completed: boolean; status: "completed" | "scheduled" | "in_progress" | "cancelled" | "postponed" | "unknown"; notes: string | null; playoff: unknown; raw: Record<string, unknown> };
export type ProviderTeam = { id: number; school: string; abbreviation: string | null; conference: string | null; classification: string | null; membership: "FBS" | "FCS" | "other"; raw: Record<string, unknown> };
export type ProviderPoll = { seasonType: string; week: number; type: "ap" | "cfp"; ranks: { teamId: number; rank: number }[]; raw: Record<string, unknown> };
export type ProviderWeek = { week: number; seasonType: string; startUtc: string; endUtc: string };

function fail(where: string): never { throw new Error(`Invalid CFBD response: ${where}`); }
function obj(v: unknown, where: string): Record<string, unknown> { if (!v || typeof v !== "object" || Array.isArray(v)) fail(where); return v as Record<string, unknown>; }
function arr(v: unknown, where: string): unknown[] { if (!Array.isArray(v)) fail(where); return v; }
function str(v: unknown, where: string): string { if (typeof v !== "string" || !v.trim()) fail(where); return v; }
function optStr(v: unknown, where: string): string | null { return v == null ? null : str(v, where); }
function int(v: unknown, where: string, min = 0): number { if (typeof v !== "number" || !Number.isSafeInteger(v) || v < min) fail(where); return v; }
function optInt(v: unknown, where: string): number | null { return v == null ? null : int(v, where); }
function utc(v: unknown, where: string): string { const s = str(v, where); if (!/T.*(?:Z|[+-]\d\d:\d\d)$/.test(s) || !Number.isFinite(Date.parse(s))) fail(where); return new Date(s).toISOString(); }
function year(v: unknown, expected: number): void { if (int(v, "season", 1869) !== expected) fail("wrong season"); }
function seasonType(v: unknown): string { const s = str(v, "seasonType"); if (!["regular", "postseason", "both", "allstar", "spring_regular", "spring_postseason"].includes(s)) fail("seasonType"); return s; }
function unique<T>(values: T[], key: (v: T) => string): T[] { const seen = new Set<string>(); for (const v of values) { const id = key(v); if (seen.has(id)) fail(`duplicate ${id}`); seen.add(id); } return values; }

export function parseGames(raw: unknown, season: number): ProviderGame[] {
  return unique(arr(raw, "games").map((value, i) => {
    const g = obj(value, `game ${i}`); year(g.season, season);
    if (typeof g.completed !== "boolean") fail("game completed flag");
    const homeId = int(g.homeId, "homeId", 1), awayId = int(g.awayId, "awayId", 1);
    if (homeId === awayId) fail("identical opponents");
    const homePoints = optInt(g.homePoints, "homePoints"), awayPoints = optInt(g.awayPoints, "awayPoints");
    if ((homePoints === null) !== (awayPoints === null) || (g.completed && homePoints === null)) fail("inconsistent scores");
    const notes = optStr(g.notes, "notes"), explicit = optStr(g.status, "status")?.toLowerCase();
    const status = explicit === "final" || explicit === "completed" ? "completed" : explicit === "canceled" || explicit === "cancelled" ? "cancelled" : explicit === "postponed" ? "postponed" : explicit === "scheduled" ? "scheduled" : explicit === "in_progress" || explicit === "in progress" ? "in_progress" : explicit ? "unknown" : /\bcancelled|canceled\b/i.test(notes ?? "") ? "cancelled" : /\bpostponed\b/i.test(notes ?? "") ? "postponed" : g.completed ? "completed" : "scheduled";
    if ((status === "completed") !== g.completed || (g.completed && /\bcancelled|canceled|postponed\b/i.test(notes ?? ""))) fail("contradictory completion");
    return { id: int(g.id, "game id", 1), season, week: int(g.week, "week"), seasonType: seasonType(g.seasonType), startDate: utc(g.startDate, "startDate"), homeId, awayId, homeTeam: str(g.homeTeam, "homeTeam"), awayTeam: str(g.awayTeam, "awayTeam"), homePoints, awayPoints, completed: g.completed, status, notes, playoff: g.playoff ?? null, raw: g };
  }), g => String(g.id));
}

export function parseTeams(raw: unknown, season: number, fbs: ReadonlySet<number>): ProviderTeam[] {
  void season;
  return unique(arr(raw, "teams").map((value, i) => {
    const t = obj(value, `team ${i}`), id = int(t.id, "team id", 1), classification = optStr(t.classification, "classification");
    if (fbs.has(id) && classification && classification.toLowerCase() !== "fbs") fail("FBS classification conflict");
    if (!fbs.has(id) && classification?.toLowerCase() === "fbs") fail("FBS roster conflict");
    return { id, school: str(t.school, "school"), abbreviation: optStr(t.abbreviation, "abbreviation"), conference: optStr(t.conference, "conference"), classification, membership: fbs.has(id) ? "FBS" as const : classification?.toLowerCase() === "fcs" ? "FCS" as const : "other" as const, raw: t };
  }), t => String(t.id));
}

export function parseRankings(raw: unknown, season: number): ProviderPoll[] {
  const result: ProviderPoll[] = [];
  for (const value of arr(raw, "rankings")) {
    const w = obj(value, "ranking week"); year(w.season, season);
    const week = int(w.week, "poll week"), type = seasonType(w.seasonType);
    for (const value of arr(w.polls, "polls")) {
      const p = obj(value, "poll"), name = str(p.poll, "poll name");
      const pollType = /^(AP|AP Top 25)$/i.test(name) ? "ap" : /^(CFP|College Football Playoff)$/i.test(name) ? "cfp" : null;
      if (!pollType) continue;
      const ranks = unique(arr(p.ranks, "ranks").map(v => { const e = obj(v, "poll entry"); return { teamId: int(e.teamId, "poll team ID", 1), rank: int(e.rank, "rank", 1) }; }), e => String(e.teamId));
      result.push({ seasonType: type, week, type: pollType, ranks, raw: p });
    }
  }
  return unique(result, p => `${p.seasonType}:${p.week}:${p.type}`);
}

export function parseCalendar(raw: unknown, season: number): ProviderWeek[] {
  return unique(arr(raw, "calendar").map(value => { const w = obj(value, "calendar week"); year(w.season, season); const startUtc = utc(w.startDate, "calendar start"), endUtc = utc(w.endDate, "calendar end"); if (startUtc > endUtc) fail("calendar reversed"); return { week: int(w.week, "calendar week"), seasonType: seasonType(w.seasonType), startUtc, endUtc }; }), w => `${w.seasonType}:${w.week}`);
}

export function createCfbdClient(options: { key?: string; fetcher?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>; sleep?: (ms: number) => Promise<void>; baseUrl?: string } = {}) {
  const key = options.key ?? process.env.CFBD_API_KEY;
  if (!key?.trim()) throw new Error("CFBD_API_KEY is missing; configure it on the server");
  const fetcher = options.fetcher ?? fetch, sleep = options.sleep ?? (ms => new Promise<void>(resolve => setTimeout(resolve, ms)));
  async function get<T>(path: string, query: Record<string, string>, parser: (raw: unknown) => T[]): Promise<Source<T>> {
    const url = new URL(path, options.baseUrl ?? "https://api.collegefootballdata.com");
    for (const [k, v] of Object.entries(query)) url.searchParams.set(k, v);
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try { response = await fetcher(url, { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" }, signal: AbortSignal.timeout(15000) }); }
      catch { if (attempt < 2) { await sleep(250 * 2 ** attempt); continue; } throw new Error("CFBD request failed or timed out"); }
      if (!response.ok) {
        if ((response.status === 429 || response.status >= 500) && attempt < 2) { const after = response.headers.get("retry-after"); const delay = Math.max(250 * 2 ** attempt, after && /^\d+$/.test(after) ? Number(after) * 1000 : 0); if (delay <= 30000) { await sleep(delay); continue; } }
        throw new Error(`CFBD HTTP ${response.status}`);
      }
      let raw: unknown;
      try { raw = await response.json(); } catch { throw new Error("CFBD returned invalid JSON"); }
      return { url: url.toString(), observedAtUtc: new Date().toISOString(), raw, items: parser(raw) };
    }
  }
  return {
    async season(season: number) {
      if (!Number.isSafeInteger(season) || season < 1998) throw new Error("Invalid season");
      const year = String(season);
      const fbs = await get("/teams/fbs", { year }, raw => unique(arr(raw, "FBS roster").map(t => int(obj(t, "FBS team").id, "FBS ID", 1)), String));
      if (!fbs.items.length) throw new Error("Empty FBS roster; previous data retained");
      const teams = await get("/teams", { year }, raw => parseTeams(raw, season, new Set(fbs.items)));
      if (fbs.items.some(id => !teams.items.some(t => t.id === id))) fail("missing FBS team");
      const sources = await Promise.all(["fbs", "fcs"].map(classification => get("/games", { year, seasonType: "both", classification }, raw => parseGames(raw, season))));
      const games = new Map<number, ProviderGame>();
      for (const source of sources) for (const game of source.items) { const previous = games.get(game.id); if (previous && JSON.stringify(previous.raw) !== JSON.stringify(game.raw)) fail("conflicting game observations"); games.set(game.id, game); }
      if (!games.size) throw new Error("Empty game response; previous data retained");
      const rankings = await get("/rankings", { year, seasonType: "both" }, raw => parseRankings(raw, season));
      const calendar = await get("/calendar", { year }, raw => parseCalendar(raw, season));
      return { fbs, teams, gameSources: sources, games: [...games.values()], rankings, calendar };
    }
  };
}

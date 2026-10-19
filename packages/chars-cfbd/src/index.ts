/** Server-only CFBD boundary. Never import into a browser/client entrypoint. */
if (typeof window !== "undefined") throw new Error("chars-cfbd is server-only");
export { createTeamResolver } from "./identity";

export type Membership = "fbs" | "fcs" | "other";
export type Source<T> = { sourceUrl: string; observedAtUtc: string; raw: unknown; items: T[] };
export type Game = {
  id: string; season: number; week: number; providerSeasonType: string;
  kickoffUtc: string; completed: boolean; homeId: string; awayId: string;
  homeTeam: string; awayTeam: string; homePoints: number | null; awayPoints: number | null;
  homeClassification: string | null; awayClassification: string | null;
  playoff: unknown | null; notes: string | null; raw: Record<string, unknown>;
};
export type Team = { id: string; school: string; abbreviation: string | null; alternateNames: string[];
  conference: string | null; classification: string | null; membership: Membership; season: number };
export type PollEntry = { teamId: string; school: string; rank: number | null; points: number | null; raw: Record<string, unknown> };
export type Poll = { name: string; isFinal: boolean | null; entries: PollEntry[]; raw: Record<string, unknown> };
export type PollWeek = { season: number; seasonType: string; week: number; polls: Poll[];
  releasedAtUtc: null; raw: Record<string, unknown> };
export type CalendarWeek = { season: number; week: number; seasonType: string; startUtc: string; endUtc: string;
  raw: Record<string, unknown> };

function invalid(context: string): never { throw new Error(`CFBD invalid response: ${context}`); }
function object(value: unknown, context: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) invalid(context);
  return value as Record<string, unknown>;
}
function list(value: unknown, context: string): unknown[] {
  if (!Array.isArray(value)) invalid(context);
  return value as unknown[];
}
function string(value: unknown, context: string): string {
  if (typeof value !== "string" || !value.trim()) invalid(context);
  return value as string;
}
function optionalString(value: unknown, context: string): string | null {
  return value == null ? null : string(value, context);
}
function integer(value: unknown, context: string, min = 0): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) invalid(context);
  return value as number;
}
function optionalInt(value: unknown, context: string): number | null {
  return value == null ? null : integer(value, context);
}
function date(value: unknown, context: string): string {
  const input = string(value, context);
  if (!/T.*(?:Z|[+-]\d\d:\d\d)$/.test(input) || Number.isNaN(Date.parse(input))) invalid(context);
  return new Date(input).toISOString();
}
function season(value: unknown, expected: number, context: string): number {
  const year = integer(value, context, 1869);
  if (year !== expected) invalid(`${context}: expected ${expected}`);
  return year;
}
function boolean(value: unknown, context: string): boolean {
  if (typeof value !== "boolean") invalid(context);
  return value as boolean;
}
function seasonType(value: unknown, context: string): string {
  const type = string(value, context);
  if (!["regular", "postseason", "both", "allstar", "spring_regular", "spring_postseason"].includes(type)) invalid(context);
  return type;
}
function distinct<T>(items: T[], key: (item: T) => string, context: string): T[] {
  const seen = new Set<string>();
  for (const item of items) {
    const id = key(item);
    if (seen.has(id)) invalid(`${context}: duplicate ${id}`);
    seen.add(id);
  }
  return items;
}
export function parseGames(raw: unknown, year: number): Game[] {
  return distinct(list(raw, "games").map((value, index) => {
    const context = `games[${index}]`, g = object(value, context);
    const homeId = String(integer(g.homeId, `${context}.homeId`, 1));
    const awayId = String(integer(g.awayId, `${context}.awayId`, 1));
    if (homeId === awayId) invalid(`${context}: identical teams`);
    const completed = boolean(g.completed, `${context}.completed`);
    const homePoints = optionalInt(g.homePoints, `${context}.homePoints`);
    const awayPoints = optionalInt(g.awayPoints, `${context}.awayPoints`);
    if (completed && (homePoints === null || awayPoints === null)) invalid(`${context}: completed without scores`);
    return { id: String(integer(g.id, `${context}.id`, 1)), season: season(g.season, year, context),
      week: integer(g.week, `${context}.week`), providerSeasonType: seasonType(g.seasonType, `${context}.seasonType`),
      kickoffUtc: date(g.startDate, `${context}.startDate`), completed, homeId, awayId,
      homeTeam: string(g.homeTeam, `${context}.homeTeam`), awayTeam: string(g.awayTeam, `${context}.awayTeam`),
      homePoints, awayPoints, homeClassification: optionalString(g.homeClassification, `${context}.homeClassification`),
      awayClassification: optionalString(g.awayClassification, `${context}.awayClassification`),
      playoff: g.playoff ?? null, notes: optionalString(g.notes, `${context}.notes`), raw: g };
  }), g => g.id, "games");
}
export function parseTeams(raw: unknown, year: number, fbsIds: ReadonlySet<string>): Team[] {
  return distinct(list(raw, "teams").map((value, index) => {
    const context = `teams[${index}]`, t = object(value, context);
    const id = String(integer(t.id, `${context}.id`, 1));
    const classification = optionalString(t.classification, `${context}.classification`);
    if (fbsIds.has(id) && classification && classification.toLowerCase() !== "fbs") invalid(`${context}: FBS membership conflict`);
    return { id, school: string(t.school, `${context}.school`),
      abbreviation: optionalString(t.abbreviation, `${context}.abbreviation`),
      alternateNames: t.alternateNames == null ? [] : list(t.alternateNames, `${context}.alternateNames`).map((n, i) => string(n, `${context}.alternateNames[${i}]`)),
      conference: optionalString(t.conference, `${context}.conference`), classification,
      membership: fbsIds.has(id) ? "fbs" : classification?.toLowerCase() === "fcs" ? "fcs" : "other", season: year };
  }), t => t.id, "teams");
}
export function parseRankings(raw: unknown, year: number): PollWeek[] {
  return distinct(list(raw, "rankings").map((value, index) => {
    const context = `rankings[${index}]`, w = object(value, context);
    const polls = distinct(list(w.polls, `${context}.polls`).map((value, i) => {
      const p = object(value, `${context}.polls[${i}]`);
      const entries = distinct(list(p.ranks, `${context}.polls[${i}].ranks`).map((value, j) => {
        const r = object(value, `${context}.polls[${i}].ranks[${j}]`);
        return { teamId: String(integer(r.teamId, "poll teamId", 1)), school: string(r.school, "poll school"),
          rank: optionalInt(r.rank, "poll rank"), points: optionalInt(r.points, "poll points"), raw: r };
      }), e => e.teamId, "poll entries");
      return { name: string(p.poll, "poll name"), isFinal: p.isFinal == null ? null : boolean(p.isFinal, "poll isFinal"), entries, raw: p };
    }), p => p.name, "polls");
    return { season: season(w.season, year, context), seasonType: seasonType(w.seasonType, `${context}.seasonType`),
      week: integer(w.week, `${context}.week`), polls, releasedAtUtc: null as null, raw: w };
  }), w => `${w.seasonType}:${w.week}`, "rankings");
}
export function parseCalendar(raw: unknown, year: number): CalendarWeek[] {
  return distinct(list(raw, "calendar").map((value, index) => {
    const context = `calendar[${index}]`, c = object(value, context);
    const startUtc = date(c.startDate, `${context}.startDate`), endUtc = date(c.endDate, `${context}.endDate`);
    if (startUtc > endUtc) invalid(`${context}: reversed dates`);
    return { season: season(c.season, year, context), week: integer(c.week, `${context}.week`),
      seasonType: seasonType(c.seasonType, `${context}.seasonType`), startUtc, endUtc, raw: c };
  }), w => `${w.seasonType}:${w.week}`, "calendar");
}

export class CfbdError extends Error {
  constructor(message: string, readonly status?: number) { super(message); this.name = "CfbdError"; }
}
export type Fetcher = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
export type ClientOptions = { fetch?: Fetcher; apiKey?: string; timeoutMs?: number; retries?: number;
  sleep?: (ms: number) => Promise<void>; now?: () => Date; baseUrl?: string };
export function createClient(options: ClientOptions = {}) {
  // Deliberately read at call time, exclusively on the server. Never include credentials in errors/URLs.
  const key = options.apiKey ?? process.env.CFBD_API_KEY;
  if (!key?.trim()) throw new CfbdError("CFBD_API_KEY is missing; configure it on the server");
  const timeoutMs = options.timeoutMs ?? 10000, retries = options.retries ?? 2;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || !Number.isSafeInteger(retries) || retries < 0 || retries > 5) throw new Error("Invalid CFBD retry/timeout configuration");
  const fetcher = options.fetch ?? fetch;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms)));
  const now = options.now ?? (() => new Date());
  const base = options.baseUrl ?? "https://api.collegefootballdata.com";
  async function request<T>(path: string, params: Record<string, string>, parse: (body: unknown) => T[]): Promise<Source<T>> {
    const url = new URL(path, base);
    for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
    for (let attempt = 0; ; attempt++) {
      let response: Response;
      try {
        response = await fetcher(url, { headers: { Authorization: `Bearer ${key}`, Accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
      } catch {
        if (attempt < retries) { await sleep(250 * 2 ** attempt); continue; }
        throw new CfbdError("CFBD network request failed or timed out");
      }
      if (!response.ok) {
        if ((response.status === 429 || response.status >= 500) && attempt < retries) {
          const retryAfter = response.headers.get("retry-after");
          const seconds = retryAfter && /^\d+$/.test(retryAfter) ? Number(retryAfter) * 1000 : retryAfter ? Date.parse(retryAfter) - Date.now() : 0;
          await sleep(Math.min(30000, Math.max(250 * 2 ** attempt, Number.isFinite(seconds) ? seconds : 0)));
          continue;
        }
        throw new CfbdError(`CFBD HTTP ${response.status}`, response.status);
      }
      let raw: unknown;
      try { raw = await response.json(); } catch { throw new CfbdError("CFBD returned invalid JSON"); }
      return { sourceUrl: url.toString(), observedAtUtc: now().toISOString(), raw, items: parse(raw) };
    }
  }
  function yearParam(year: number): string { return String(integer(year, "requested year", 1869)); }
  return {
    async games(year: number) {
      const params = { year: yearParam(year), seasonType: "both" };
      // Do not assume a classification filter includes cross-division opponents.
      const fbs = await request("/games", { ...params, classification: "fbs" }, raw => parseGames(raw, year));
      const fcs = await request("/games", { ...params, classification: "fcs" }, raw => parseGames(raw, year));
      const games = new Map(fbs.items.map(game => [game.id, game]));
      for (const game of fcs.items) {
        const previous = games.get(game.id);
        if (previous && JSON.stringify(previous.raw) !== JSON.stringify(game.raw)) throw new CfbdError(`CFBD conflicting classification payload for game ${game.id}`);
        games.set(game.id, game);
      }
      return { ...fbs, items: [...games.values()], sources: [fbs, fcs] };
    },
    async teams(year: number) {
      const y = yearParam(year);
      const fbs = await request("/teams/fbs", { year: y }, raw => parseTeams(raw, year, new Set()));
      const ids = new Set(fbs.items.map(team => team.id));
      const all = await request("/teams", { year: y }, raw => parseTeams(raw, year, ids));
      if (ids.size !== fbs.items.length || [...ids].some(id => !all.items.some(team => team.id === id))) throw new CfbdError("CFBD FBS roster conflicts with season teams");
      return { ...all, items: all.items, fbsSource: fbs };
    },
    rankings(year: number) { return request("/rankings", { year: yearParam(year), seasonType: "both" }, raw => parseRankings(raw, year)); },
    calendar(year: number) { return request("/calendar", { year: yearParam(year) }, raw => parseCalendar(raw, year)); }
  };
}

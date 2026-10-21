import { openDatabase } from "./database";

export type Record = { wins: number; losses: number; ties: number; remaining: number };

export type SeasonSummary = {
  year: number;
  fbsTeams: number;
  scheduled: number;
  played: number;
};

export type Standing = Record & {
  teamId: string;
  teamName: string;
  abbreviation: string;
  conference: string;
};

export type ScheduleGame = {
  gameId: number;
  week: number;
  startDate: number;
  opponentId: string;
  opponentName: string;
  opponentClass: string | null;
  home: 0 | 1;
  teamScore: number | null;
  opponentScore: number | null;
  overtimes: number | null;
};

async function withDatabase<T>(query: (sql: ReturnType<typeof openDatabase>["sql"]) => Promise<T>): Promise<T> {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is required; configure your environment before starting CHARS.");
  }
  const connection = openDatabase();
  try {
    return await query(connection.sql);
  } finally {
    await connection.close();
  }
}

export function getSeasons(): Promise<SeasonSummary[]> {
  return withDatabase(async (sql) => await sql`
    SELECT s.year AS year,
       sum(CASE WHEN s.classification = 'FBS' THEN 1 ELSE 0 END)::int AS "fbsTeams",
      (SELECT count(*) FROM games g WHERE g.year = s.year
        AND (EXISTS (SELECT 1 FROM seasons fs WHERE fs.year = s.year AND fs.team_id = g.home_team AND fs.classification = 'FBS')
          OR EXISTS (SELECT 1 FROM seasons fs WHERE fs.year = s.year AND fs.team_id = g.away_team AND fs.classification = 'FBS')))::int AS scheduled,
      (SELECT count(*) FROM games g WHERE g.year = s.year AND g.home_score IS NOT NULL AND g.away_score IS NOT NULL
        AND (EXISTS (SELECT 1 FROM seasons fs WHERE fs.year = s.year AND fs.team_id = g.home_team AND fs.classification = 'FBS')
          OR EXISTS (SELECT 1 FROM seasons fs WHERE fs.year = s.year AND fs.team_id = g.away_team AND fs.classification = 'FBS')))::int AS played
    FROM seasons s
    GROUP BY s.year ORDER BY s.year DESC
  ` as SeasonSummary[]);
}

export function hasSeason(year: number): Promise<boolean> {
  return withDatabase(async (sql) => (await sql`SELECT 1 FROM seasons WHERE year = ${year} LIMIT 1`).length !== 0);
}

export function getStandings(year: number): Promise<Standing[]> {
  return withDatabase(async (sql) => await sql`
    SELECT s.team_id AS "teamId", t.team_name AS "teamName", t.abbreviation AS abbreviation,
      c.name AS conference,
      sum(CASE WHEN g.game_id IS NOT NULL AND g.home_score IS NOT NULL AND g.away_score IS NOT NULL
        AND ((g.home_team = s.team_id AND g.home_score > g.away_score)
          OR (g.away_team = s.team_id AND g.away_score > g.home_score)) THEN 1 ELSE 0 END)::int AS wins,
      sum(CASE WHEN g.game_id IS NOT NULL AND g.home_score IS NOT NULL AND g.away_score IS NOT NULL
        AND ((g.home_team = s.team_id AND g.home_score < g.away_score)
          OR (g.away_team = s.team_id AND g.away_score < g.home_score)) THEN 1 ELSE 0 END)::int AS losses,
      sum(CASE WHEN g.home_score IS NOT NULL AND g.away_score IS NOT NULL AND g.home_score = g.away_score THEN 1 ELSE 0 END)::int AS ties,
      sum(CASE WHEN g.game_id IS NOT NULL AND (g.home_score IS NULL OR g.away_score IS NULL) THEN 1 ELSE 0 END)::int AS remaining
    FROM seasons s
    JOIN teams t ON t.team_id = s.team_id
    JOIN conferences c ON c.conference_id = s.conference_id
    LEFT JOIN games g ON g.year = s.year AND (g.home_team = s.team_id OR g.away_team = s.team_id)
    WHERE s.year = ${year} AND s.classification = 'FBS'
    GROUP BY s.team_id, t.team_name, t.abbreviation, c.name
    ORDER BY wins DESC, losses ASC, ties DESC, t.team_name ASC
  ` as Standing[]);
}

export async function getTeam(year: number, teamId: string): Promise<Standing | null> {
  return (await getStandings(year)).find((team) => team.teamId === teamId) ?? null;
}

export function getSchedule(year: number, teamId: string): Promise<ScheduleGame[]> {
  return withDatabase(async (sql) => await sql`
    SELECT g.game_id::float8 AS "gameId", g.week AS week, g.start_date::float8 AS "startDate",
      o.team_id AS "opponentId", o.team_name AS "opponentName", os.classification AS "opponentClass",
      (g.home_team = ${teamId})::int AS home,
      CASE WHEN g.home_team = ${teamId} THEN g.home_score ELSE g.away_score END AS "teamScore",
      CASE WHEN g.home_team = ${teamId} THEN g.away_score ELSE g.home_score END AS "opponentScore",
      g.overtimes AS overtimes
    FROM games g
    JOIN teams o ON o.team_id = CASE WHEN g.home_team = ${teamId} THEN g.away_team ELSE g.home_team END
    LEFT JOIN seasons os ON os.year = g.year AND os.team_id = o.team_id
    WHERE g.year = ${year} AND (g.home_team = ${teamId} OR g.away_team = ${teamId})
    ORDER BY g.start_date ASC, g.week ASC, g.game_id ASC
  ` as ScheduleGame[]);
}

export function parseYear(value: string): number | null {
  if (!/^\d{4}$/.test(value)) return null;
  const year = Number(value);
  return Number.isSafeInteger(year) ? year : null;
}

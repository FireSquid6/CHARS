import { openDatabase } from "chars-db";

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

function withDatabase<T>(query: (sqlite: ReturnType<typeof openDatabase>["sqlite"]) => T): T {
  if (!process.env.DATABASE_PATH) {
    throw new Error("DATABASE_PATH is required; configure site/.env.local before starting CHARS.");
  }
  const connection = openDatabase();
  try {
    return query(connection.sqlite);
  } finally {
    connection.close();
  }
}

export function getSeasons(): SeasonSummary[] {
  return withDatabase((sqlite) => sqlite.query(`
    SELECT s.year AS year,
       sum(CASE WHEN s.classification = 'FBS' THEN 1 ELSE 0 END) AS fbsTeams,
      (SELECT count(*) FROM games g WHERE g.year = s.year
        AND (EXISTS (SELECT 1 FROM seasons fs WHERE fs.year = s.year AND fs.team_id = g.home_team AND fs.classification = 'FBS')
          OR EXISTS (SELECT 1 FROM seasons fs WHERE fs.year = s.year AND fs.team_id = g.away_team AND fs.classification = 'FBS'))) AS scheduled,
      (SELECT count(*) FROM games g WHERE g.year = s.year AND g.home_score IS NOT NULL AND g.away_score IS NOT NULL
        AND (EXISTS (SELECT 1 FROM seasons fs WHERE fs.year = s.year AND fs.team_id = g.home_team AND fs.classification = 'FBS')
          OR EXISTS (SELECT 1 FROM seasons fs WHERE fs.year = s.year AND fs.team_id = g.away_team AND fs.classification = 'FBS'))) AS played
    FROM seasons s
    GROUP BY s.year ORDER BY s.year DESC
  `).all() as SeasonSummary[]);
}

export function hasSeason(year: number): boolean {
  return withDatabase((sqlite) => sqlite.query("SELECT 1 FROM seasons WHERE year = ? LIMIT 1").get(year) !== null);
}

export function getStandings(year: number): Standing[] {
  return withDatabase((sqlite) => sqlite.query(`
    SELECT s.team_id AS teamId, t.team_name AS teamName, t.abbreviation AS abbreviation,
      c.name AS conference,
      sum(CASE WHEN g.game_id IS NOT NULL AND g.home_score IS NOT NULL AND g.away_score IS NOT NULL
        AND ((g.home_team = s.team_id AND g.home_score > g.away_score)
          OR (g.away_team = s.team_id AND g.away_score > g.home_score)) THEN 1 ELSE 0 END) AS wins,
      sum(CASE WHEN g.game_id IS NOT NULL AND g.home_score IS NOT NULL AND g.away_score IS NOT NULL
        AND ((g.home_team = s.team_id AND g.home_score < g.away_score)
          OR (g.away_team = s.team_id AND g.away_score < g.home_score)) THEN 1 ELSE 0 END) AS losses,
      sum(CASE WHEN g.home_score IS NOT NULL AND g.away_score IS NOT NULL AND g.home_score = g.away_score THEN 1 ELSE 0 END) AS ties,
      sum(CASE WHEN g.game_id IS NOT NULL AND (g.home_score IS NULL OR g.away_score IS NULL) THEN 1 ELSE 0 END) AS remaining
    FROM seasons s
    JOIN teams t ON t.team_id = s.team_id
    JOIN conferences c ON c.conference_id = s.conference_id
    LEFT JOIN games g ON g.year = s.year AND (g.home_team = s.team_id OR g.away_team = s.team_id)
    WHERE s.year = ? AND s.classification = 'FBS'
    GROUP BY s.team_id, t.team_name, t.abbreviation, c.name
    ORDER BY wins DESC, losses ASC, ties DESC, t.team_name ASC
  `).all(year) as Standing[]);
}

export function getTeam(year: number, teamId: string): Standing | null {
  return getStandings(year).find((team) => team.teamId === teamId) ?? null;
}

export function getSchedule(year: number, teamId: string): ScheduleGame[] {
  return withDatabase((sqlite) => sqlite.query(`
    SELECT g.game_id AS gameId, g.week AS week, g.start_date AS startDate,
      o.team_id AS opponentId, o.team_name AS opponentName, os.classification AS opponentClass,
      (g.home_team = ?) AS home,
      CASE WHEN g.home_team = ? THEN g.home_score ELSE g.away_score END AS teamScore,
      CASE WHEN g.home_team = ? THEN g.away_score ELSE g.home_score END AS opponentScore,
      g.overtimes AS overtimes
    FROM games g
    JOIN teams o ON o.team_id = CASE WHEN g.home_team = ? THEN g.away_team ELSE g.home_team END
    LEFT JOIN seasons os ON os.year = g.year AND os.team_id = o.team_id
    WHERE g.year = ? AND (g.home_team = ? OR g.away_team = ?)
    ORDER BY g.start_date ASC, g.week ASC, g.game_id ASC
  `).all(teamId, teamId, teamId, teamId, year, teamId, teamId) as ScheduleGame[]);
}

export function parseYear(value: string): number | null {
  if (!/^\d{4}$/.test(value)) return null;
  const year = Number(value);
  return Number.isSafeInteger(year) ? year : null;
}

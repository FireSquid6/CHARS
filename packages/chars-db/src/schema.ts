import { sql } from "drizzle-orm";
import { check, index, integer, primaryKey, sqliteTable, text } from "drizzle-orm/sqlite-core";

export const teams = sqliteTable("teams", {
  teamId: text("team_id").primaryKey(),
  teamName: text("team_name").notNull(),
  abbreviation: text("abbreviation").notNull(),
});

export const conferences = sqliteTable("conferences", {
  conferenceId: text("conference_id").primaryKey(),
  name: text("name").notNull(),
  abbreviation: text("abbreviation").notNull(),
});

export const classifications = ["FBS", "FCS", "DIV2", "DIV3"] as const;

export const seasons = sqliteTable("seasons", {
  teamId: text("team_id").notNull().references(() => teams.teamId),
  year: integer("year").notNull(),
  conferenceId: text("conference_id").notNull().references(() => conferences.conferenceId),
  division: text("division"),
  classification: text("classification", { enum: classifications }).notNull(),
}, (table) => [
  primaryKey({ columns: [table.teamId, table.year] }),
  check("seasons_classification_check", sql`${table.classification} IN ('FBS', 'FCS', 'DIV2', 'DIV3')`),
  index("seasons_year_idx").on(table.year),
]);

// Only regular-season games belong here. Equal scores represent ties;
// null scores represent results that are not yet known.
export const games = sqliteTable("games", {
  gameId: integer("game_id").primaryKey(),
  homeTeam: text("home_team").notNull().references(() => teams.teamId),
  awayTeam: text("away_team").notNull().references(() => teams.teamId),
  year: integer("year").notNull(),
  week: integer("week").notNull(),
  startDate: integer("start_date", { mode: "timestamp_ms" }).notNull(),
  homeScore: integer("home_score"),
  awayScore: integer("away_score"),
  overtimes: integer("overtimes"),
}, (table) => [
  check("games_different_teams_check", sql`${table.homeTeam} <> ${table.awayTeam}`),
  check("games_home_score_check", sql`${table.homeScore} >= 0`),
  check("games_away_score_check", sql`${table.awayScore} >= 0`),
  check("games_overtimes_check", sql`${table.overtimes} >= 0`),
  index("games_year_week_idx").on(table.year, table.week),
  index("games_home_team_year_idx").on(table.homeTeam, table.year),
  index("games_away_team_year_idx").on(table.awayTeam, table.year),
]);

export const pollReleases = sqliteTable("poll_releases", {
  releaseId: text("release_id").primaryKey(),
  pollId: text("poll_id").notNull(),
  year: integer("year").notNull(),
  week: integer("week").notNull(),
  releasedAt: integer("released_at", { mode: "timestamp_ms" }).notNull(),
}, (table) => [
  index("poll_releases_poll_year_week_idx").on(table.pollId, table.year, table.week),
]);

export const pollEntries = sqliteTable("poll_entries", {
  releaseId: text("release_id").notNull().references(() => pollReleases.releaseId),
  teamId: text("team_id").notNull().references(() => teams.teamId),
  rank: integer("rank").notNull(),
}, (table) => [
  primaryKey({ columns: [table.releaseId, table.teamId] }),
  check("poll_entries_rank_check", sql`${table.rank} > 0`),
]);

export type Team = typeof teams.$inferSelect;
export type NewTeam = typeof teams.$inferInsert;
export type Conference = typeof conferences.$inferSelect;
export type NewConference = typeof conferences.$inferInsert;
export type Season = typeof seasons.$inferSelect;
export type NewSeason = typeof seasons.$inferInsert;
export type Classification = typeof classifications[number];
export type Game = typeof games.$inferSelect;
export type NewGame = typeof games.$inferInsert;
export type PollRelease = typeof pollReleases.$inferSelect;
export type NewPollRelease = typeof pollReleases.$inferInsert;
export type PollEntry = typeof pollEntries.$inferSelect;
export type NewPollEntry = typeof pollEntries.$inferInsert;

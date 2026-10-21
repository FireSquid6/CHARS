import { sql } from "drizzle-orm";
import { bigint, check, date, index, integer, pgTable, pgView, primaryKey, text, unique, boolean } from "drizzle-orm/pg-core";

export const teams = pgTable("teams", {
  teamId: text("team_id").primaryKey(),
  teamName: text("team_name").notNull(),
  abbreviation: text("abbreviation").notNull(),
});

export const conferences = pgTable("conferences", {
  conferenceId: text("conference_id").primaryKey(),
  name: text("name").notNull(),
  abbreviation: text("abbreviation").notNull(),
});

export const classifications = ["FBS", "FCS", "DIV2", "DIV3"] as const;

export const seasons = pgTable("seasons", {
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
export const games = pgTable("games", {
  gameId: bigint("game_id", { mode: "number" }).primaryKey().generatedByDefaultAsIdentity(),
  homeTeam: text("home_team").notNull().references(() => teams.teamId),
  awayTeam: text("away_team").notNull().references(() => teams.teamId),
  year: integer("year").notNull(),
  week: integer("week").notNull(),
  startDate: bigint("start_date", { mode: "number" }).notNull(),
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

export const pollReleases = pgTable("poll_releases", {
  releaseId: text("release_id").primaryKey(),
  pollId: text("poll_id").notNull(),
  year: integer("year").notNull(),
  week: integer("week").notNull(),
  pollDate: date("poll_date"),
  pollPhase: text("poll_phase").notNull(),
  weekLabel: text("week_label").notNull(),
  pollSequence: integer("poll_sequence").notNull(),
  weekReferenceDate: date("week_reference_date"),
  sourceSeasonType: integer("source_season_type"),
  sourceWeek: integer("source_week"),
  sourceUrl: text("source_url").notNull(),
  dateSourceUrl: text("date_source_url"),
  notes: text("notes"),
}, (table) => [
  check("poll_releases_phase_check", sql`${table.pollPhase} IN ('preseason', 'regular', 'selection', 'final')`),
  check("poll_releases_poll_sequence_check", sql`${table.pollSequence} > 0`),
  check("poll_releases_poll_type_check", sql`${table.pollId} IN ('AP', 'COACHES', 'CFP')`),
  unique("poll_releases_season_sequence_key").on(table.pollId, table.year, table.pollSequence),
  index("poll_releases_poll_year_week_idx").on(table.pollId, table.year, table.week),
  index("poll_releases_type_season_idx").on(table.pollId, table.year, table.pollSequence),
]);

export const pollEntries = pgTable("poll_entries", {
  releaseId: text("release_id").notNull().references(() => pollReleases.releaseId),
  teamId: text("team_id").notNull().references(() => teams.teamId),
  rank: integer("rank").notNull(),
  points: integer("points"),
  firstPlaceVotes: integer("first_place_votes"),
  record: text("record"),
  sourceRankOverride: integer("source_rank_override"),
  sourceTeamNameOverride: text("source_team_name_override"),
  sourceTeamIdOverride: text("source_team_id_override"),
  notes: text("notes"),
}, (table) => [
  primaryKey({ columns: [table.releaseId, table.teamId] }),
  check("poll_entries_rank_check", sql`${table.rank} > 0`),
  check("poll_entries_points_check", sql`${table.points} >= 0`),
  check("poll_entries_first_place_votes_check", sql`${table.firstPlaceVotes} >= 0`),
  check("poll_entries_source_rank_override_check", sql`${table.sourceRankOverride} > 0`),
  index("poll_entries_team_idx").on(table.teamId),
]);

export const pollTeamNames = pgTable("poll_team_names", {
  teamId: text("team_id").primaryKey().references(() => teams.teamId),
  displayName: text("display_name").notNull(),
});

export const pollRankings = pgView("poll_rankings", {
  releaseId: text("release_id"), pollId: text("poll_id"), season: integer("season"),
  week: integer("week"), pollPhase: text("poll_phase"), weekLabel: text("week_label"),
  pollSequence: integer("poll_sequence"), pollDate: date("poll_date"),
  weekReferenceDate: date("week_reference_date"), rank: integer("rank"),
  teamId: text("team_id"), team: text("team"), espnTeamId: text("espn_team_id"),
  points: integer("points"), firstPlaceVotes: integer("first_place_votes"),
  record: text("record"), previousRank: integer("previous_rank"),
  isTied: boolean("is_tied"), sourceRank: integer("source_rank"),
  sourceTeamName: text("source_team_name"), sourceSeasonType: integer("source_season_type"),
  sourceWeek: integer("source_week"), sourceUrl: text("source_url"),
  dateSourceUrl: text("date_source_url"), notes: text("notes"),
}).existing();

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
export type PollTeamName = typeof pollTeamNames.$inferSelect;
export type PollRanking = typeof pollRankings.$inferSelect;

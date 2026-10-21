CREATE TABLE `conferences` (
	`conference_id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`abbreviation` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `games` (
	`game_id` integer PRIMARY KEY NOT NULL,
	`home_team` text NOT NULL,
	`away_team` text NOT NULL,
	`year` integer NOT NULL,
	`week` integer NOT NULL,
	`start_date` integer NOT NULL,
	`home_score` integer,
	`away_score` integer,
	`overtimes` integer,
	FOREIGN KEY (`home_team`) REFERENCES `teams`(`team_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`away_team`) REFERENCES `teams`(`team_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "games_different_teams_check" CHECK("games"."home_team" <> "games"."away_team"),
	CONSTRAINT "games_home_score_check" CHECK("games"."home_score" >= 0),
	CONSTRAINT "games_away_score_check" CHECK("games"."away_score" >= 0),
	CONSTRAINT "games_overtimes_check" CHECK("games"."overtimes" >= 0)
);
--> statement-breakpoint
CREATE INDEX `games_year_week_idx` ON `games` (`year`,`week`);--> statement-breakpoint
CREATE INDEX `games_home_team_year_idx` ON `games` (`home_team`,`year`);--> statement-breakpoint
CREATE INDEX `games_away_team_year_idx` ON `games` (`away_team`,`year`);--> statement-breakpoint
CREATE TABLE `poll_entries` (
	`release_id` text NOT NULL,
	`team_id` text NOT NULL,
	`rank` integer NOT NULL,
	PRIMARY KEY(`release_id`, `team_id`),
	FOREIGN KEY (`release_id`) REFERENCES `poll_releases`(`release_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`team_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "poll_entries_rank_check" CHECK("poll_entries"."rank" > 0)
);
--> statement-breakpoint
CREATE TABLE `poll_releases` (
	`release_id` text PRIMARY KEY NOT NULL,
	`poll_id` text NOT NULL,
	`year` integer NOT NULL,
	`week` integer NOT NULL,
	`released_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `poll_releases_poll_year_week_idx` ON `poll_releases` (`poll_id`,`year`,`week`);--> statement-breakpoint
CREATE TABLE `seasons` (
	`team_id` text NOT NULL,
	`year` integer NOT NULL,
	`conference_id` text NOT NULL,
	`division` text,
	`classification` text NOT NULL,
	PRIMARY KEY(`team_id`, `year`),
	FOREIGN KEY (`team_id`) REFERENCES `teams`(`team_id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`conference_id`) REFERENCES `conferences`(`conference_id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "seasons_classification_check" CHECK("seasons"."classification" IN ('FBS', 'FCS', 'DIV2', 'DIV3'))
);
--> statement-breakpoint
CREATE INDEX `seasons_year_idx` ON `seasons` (`year`);--> statement-breakpoint
CREATE TABLE `teams` (
	`team_id` text PRIMARY KEY NOT NULL,
	`team_name` text NOT NULL,
	`abbreviation` text NOT NULL
);

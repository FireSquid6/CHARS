#!/usr/bin/env bun
import { Command, InvalidArgumentError } from "commander";
import { openDatabase } from "chars-db";
import { getSchedule, getSeasons, getStandings, hasSeason, parseYear, type Standing } from "chars-db/archive";
import { render, type Format, type Row } from "./output";

const gameDate = new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric", timeZone: "Pacific/Honolulu" });

function year(value: string): number {
  const parsed = parseYear(value);
  if (parsed === null) throw new InvalidArgumentError("year must be four digits");
  return parsed;
}

function resolveTeam(standings: Standing[], input: string): Standing {
  const matches = standings.filter((team) =>
    [team.teamId, team.teamName, team.abbreviation].some((value) => value.toLowerCase() === input.toLowerCase()));
  if (!matches.length) throw new Error(`No FBS team matching "${input}" in this season.`);
  if (matches.length > 1) throw new Error(`Ambiguous team "${input}"; use one of these IDs: ${matches.map((team) => team.teamId).join(", ")}`);
  return matches[0]!;
}

async function seasonStandings(season: number): Promise<Standing[]> {
  const standings = await getStandings(season);
  if (!standings.length && !(await hasSeason(season))) throw new Error(`Season ${season} was not found.`);
  return standings;
}

export function createProgram(write: (output: string) => void = console.log): Command {
  const program = new Command();
  program.name("chars").description("Query the CHARS college football archive (read-only)")
    .option("-f, --format <format>", "output format: table, json, csv", "table")
    .showHelpAfterError();

  function output(rows: Row[], columns?: string[]) {
    const format = program.opts<{ format: string }>().format;
    if (!["table", "json", "csv"].includes(format)) throw new Error(`Unknown format "${format}" (choose table, json, or csv).`);
    write(render(rows, format as Format, columns));
  }

  program.command("seasons").description("List available seasons and game counts")
    .action(async () => output(await getSeasons()));

  program.command("standings").description("List FBS records for a season")
    .argument("<year>", "four-digit season year", year)
    .action(async (season: number) => output(await seasonStandings(season)));

  program.command("team").description("Show an FBS team's record and schedule")
    .argument("<year>", "four-digit season year", year)
    .argument("<team>", "team ID, name or abbreviation")
    .action(async (season: number, input: string) => {
      const team = resolveTeam(await seasonStandings(season), input);
      output([{ year: season, ...team }]);
    });

  program.command("schedule").description("Show an FBS team's regular-season games")
    .argument("<year>", "four-digit season year", year)
    .argument("<team>", "team ID, name or abbreviation")
    .action(async (season: number, input: string) => {
      const team = resolveTeam(await seasonStandings(season), input);
      const games = await getSchedule(season, team.teamId);
      output(games.map((game) => {
        const played = game.teamScore !== null && game.opponentScore !== null;
        return {
          week: game.week,
          date: gameDate.format(new Date(game.startDate)),
          site: game.home ? "vs" : "at",
          opponent: game.opponentName,
          classification: game.opponentClass,
          score: played ? `${game.teamScore}-${game.opponentScore}${game.overtimes ? ` (${game.overtimes} OT)` : ""}` : null,
          result: !played ? "Upcoming" : game.teamScore! > game.opponentScore! ? "W" : game.teamScore! < game.opponentScore! ? "L" : "T",
        };
      }), ["week", "date", "site", "opponent", "classification", "score", "result"]);
    });

  program.command("sql").description("Run a single read-only SELECT query")
    .argument("<query>", "SELECT query (quote it in your shell)")
    .action(async (query: string) => {
      if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required; configure your environment before starting CHARS.");
      const statement = query.trim().replace(/;\s*$/, "");
      if (!statement) throw new Error("A SELECT query is required.");
      const connection = openDatabase();
      try {
        const rows = await connection.sql.begin(async (tx) => {
          await tx`SET TRANSACTION READ ONLY`;
          // A derived table only accepts one row-returning query. SQL cannot escape it
          // with a semicolon, and the transaction additionally rejects database writes.
          return await tx.unsafe(`SELECT * FROM (${statement}) AS chars_result`);
        });
        output(rows as Row[]);
      } finally {
        await connection.close();
      }
    });

  return program;
}

if (import.meta.main) {
  try {
    await createProgram().parseAsync(process.argv);
  } catch (error) {
    console.error(`chars: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

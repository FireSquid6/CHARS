import { afterAll, expect, test } from "bun:test";
import { eq, getTableColumns, getTableName } from "drizzle-orm";
import { openDatabase } from "../src/database";
import { conferences, games, gameTypes, pollEntries, pollRankings, pollReleases, pollTeamNames, seasons, teams } from "../src/schema";

const connection = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL
  ? openDatabase(process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL)
  : process.env.TEST_PG_SOCKET
    ? openDatabase({ path: process.env.TEST_PG_SOCKET, username: process.env.TEST_PG_USER ?? "postgres", database: "cfbdb" })
    : null;

afterAll(async () => { await connection?.close(); });

test.skipIf(!connection)("schema maps the existing PostgreSQL database without modifying it", async () => {
  const { db, sql } = connection!;
  const tables = [teams, conferences, seasons, games, pollReleases, pollEntries, pollTeamNames];
  for (const table of tables) {
    expect((await db.select().from(table).limit(1)).length).toBeLessThanOrEqual(1);
    const actual = await sql`SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = ${getTableName(table)}
      ORDER BY column_name`;
    expect(Object.values(getTableColumns(table)).map((column) => column.name).sort())
      .toEqual(actual.map((row: { column_name: string }) => row.column_name));
  }
  expect((await db.select().from(pollRankings).limit(1)).length).toBeLessThanOrEqual(1);
  const [game] = await db.select().from(games).limit(1);
  if (game) {
    expect(typeof game.startDate).toBe("number");
    expect((await db.select().from(games).where(eq(games.gameId, game.gameId)).limit(1))[0]?.gameId).toBe(game.gameId);
  }
  const [release] = await db.select().from(pollReleases).limit(1);
  if (release) expect(release.pollDate === null || /^\d{4}-\d{2}-\d{2}$/.test(release.pollDate)).toBe(true);
  const rows = await sql`select column_name from information_schema.columns where table_schema = 'public' and table_name = 'poll_releases'`;
  expect(rows.map((row: { column_name: string }) => row.column_name)).toContain("poll_sequence");
  expect(rows.map((row: { column_name: string }) => row.column_name)).not.toContain("released_at");
});

test("requires an explicit database configuration", () => {
  expect(() => openDatabase("")).toThrow("DATABASE_URL is required");
});

test("game type is nullable and restricted to the four supported categories", () => {
  expect(getTableColumns(games).gameType.name).toBe("game_type");
  expect(getTableColumns(games).gameType.notNull).toBe(false);
  expect(gameTypes).toEqual(["regular", "ccg", "playoff", "bowl"]);
});

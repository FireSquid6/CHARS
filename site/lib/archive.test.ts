import { expect, test } from "bun:test";
import { getSchedule, getSeasons, getStandings, getTeam, hasSeason, parseYear } from "./archive";

test.skipIf(!process.env.DATABASE_URL)("reads archive data from PostgreSQL", async () => {
  const seasons = await getSeasons();
  expect(seasons.length).toBeGreaterThan(0);
  const year = seasons[0]!.year;
  expect(await hasSeason(year)).toBe(true);
  expect(await hasSeason(9999)).toBe(false);
  const standings = await getStandings(year);
  expect(standings.length).toBe(seasons[0]!.fbsTeams);
  if (standings.length) {
    const team = standings[0]!;
    expect(await getTeam(year, team.teamId)).toEqual(team);
    const schedule = await getSchedule(year, team.teamId);
    expect(schedule.every((game) => typeof game.startDate === "number" && (game.home === 0 || game.home === 1))).toBe(true);
  }
});

test("year URLs must contain exactly four digits", () => {
  expect(parseYear("2024")).toBe(2024);
  expect(parseYear("2024garbage")).toBeNull();
  expect(parseYear("-2024")).toBeNull();
});

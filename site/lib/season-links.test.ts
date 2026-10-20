import { expect, test } from "bun:test";
import { seasonHref, teamHref } from "./season-links";

test("team links and return links preserve shareable snapshot keys", () => {
  expect(teamHref(2024, "Miami (FL)", "2024-week_final-2_abc"))
    .toBe("/seasons/2024/teams/Miami%20(FL)?week=2024-week_final-2_abc");
  expect(seasonHref(2024, "week & 2")).toBe("/seasons/2024?week=week%20%26%202");
  expect(teamHref(2024, "A/B")).toBe("/seasons/2024/teams/A%2FB");
  expect(seasonHref(2024)).toBe("/seasons/2024");
});

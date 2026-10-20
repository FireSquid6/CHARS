import { expect, test } from "bun:test";
import { formatGameDate } from "./format-date";

test("Eastern Saturday evening kickoffs after midnight UTC retain Saturday", () => {
  expect(formatGameDate(Date.parse("2001-09-02T00:00:00Z"))).toBe("Sep 1");
  expect(formatGameDate(Date.parse("2001-09-02T02:00:00Z"))).toBe("Sep 1");
});

test("Hawai'i vs Montana on September 8, 2001 remains on Saturday", () => {
  expect(formatGameDate(Date.parse("2001-09-09T04:05:00Z"))).toBe("Sep 8");
});

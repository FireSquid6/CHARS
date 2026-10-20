import { expect, test } from "bun:test";
import { formatGameDate } from "./format-date";

test("kickoffs after midnight UTC retain the Eastern schedule date", () => {
  expect(formatGameDate(Date.parse("2001-09-02T00:00:00Z"))).toBe("Sep 1");
  expect(formatGameDate(Date.parse("2001-09-02T02:00:00Z"))).toBe("Sep 1");
});

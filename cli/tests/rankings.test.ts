import { expect, test } from "bun:test";
import { chooseFinalPoll, chooseWeeklyPoll, cutoffDate, pickTerminal } from "../src/rankings";

const release = (id: string, type: "AP" | "CFP", phase: string, date: string) => ({ id, type, phase, week: 14,
  released: `${date}T00:00:00.000Z`, reference: `${date}T00:00:00.000Z` });

test("terminal cutoff comes from pre-selection CFP reference, not selection poll or universal week", () => {
  const polls = [release("cfp-regular", "CFP", "regular", "2025-11-30"), release("cfp-selection", "CFP", "selection", "2025-12-07")];
  expect(pickTerminal(polls, 2025)).toEqual({ cutoff: "2025-11-30T23:59:59.999Z", release: polls[0] });
  expect(pickTerminal(polls, 2025, "2025-11-29").cutoff).toBe("2025-11-29T23:59:59.999Z");
  expect(() => pickTerminal([polls[0]], 2026)).toThrow("cannot be inferred");
  expect(() => cutoffDate("2025-02-30")).toThrow();
});

test("AP association before CFP and CFP preference with a shared reference date", () => {
  const ap = release("ap", "AP", "regular", "2025-11-02");
  const cfp = { ...release("cfp", "CFP", "regular", "2025-11-02"), released: "2025-11-04T00:00:00.000Z" };
  const last = Date.parse("2025-11-01T23:00:00.000Z");
  const next = Date.parse("2025-11-06T00:00:00.000Z");
  expect(chooseWeeklyPoll([ap], last, next, "2025-11-30T23:59:59.999Z")?.id).toBe("ap");
  expect(chooseWeeklyPoll([ap, cfp], last, next, "2025-11-30T23:59:59.999Z")?.id).toBe("cfp");
  expect(chooseFinalPoll([ap, cfp], "2025-11-05T23:59:59.999Z")?.id).toBe("cfp");
});

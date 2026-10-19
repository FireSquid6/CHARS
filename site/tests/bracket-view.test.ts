import { expect, test } from "bun:test";
import { bracketView, type BracketRow, type BracketTeam } from "../lib/bracket-view";

const teams: BracketTeam[] = [
  { id: "A", name: "Alpha", abbreviation: "A", category: "bid" },
  { id: "B", name: "Beta", abbreviation: "B", category: "playin" },
  { id: "C", name: "Charlie", abbreviation: "C", category: "playin" },
  { id: "D", name: "Delta", abbreviation: "D", category: "playin" },
];
const row = (round: number, position: number, fields: Partial<BracketRow> = {}): BracketRow => ({
  round, position, seed: null, team_a_id: null, team_b_id: null,
  source_slot_a: null, source_slot_b: null, is_bye: 0, ...fields,
});
const slot = (position: number, a: string, b: string | null, pairId: string | null) =>
  row(0, position, { seed: position + 1, team_a_id: a, team_b_id: b, source_slot_a: pairId });
const ref = (slotId: string) => JSON.stringify({ kind: "slot", slotId });
const winner = (matchId: string) => JSON.stringify({ kind: "winner", matchId });

test("odd play-in field retains bye, alternatives, fixed seed and unresolved later winner", () => {
  const view = bracketView([
    slot(0, "A", null, null), slot(1, "B", null, null), slot(2, "C", "D", "playin-1"),
    row(1, 0, { source_slot_a: ref("main-slot-1"), is_bye: 1 }),
    row(1, 1, { source_slot_a: ref("main-slot-3"), source_slot_b: ref("main-slot-2") }),
    row(2, 0, { source_slot_a: ref("main-slot-1"), source_slot_b: winner("main-1-2") }),
  ], teams);
  expect(view.playins).toEqual([{ id: "playin-1", seed: 3, first: "Charlie", second: "Delta" }]);
  expect(view.playinByes).toEqual([{ seed: 2, name: "Beta" }]);
  expect(view.rounds[0]?.matches[0]).toMatchObject({ bye: true, sides: [{ label: "Alpha", seed: 1 }, null] });
  expect(view.rounds[0]?.matches[1]?.sides[0]).toMatchObject({ label: "Charlie / Delta", seed: 3 });
  expect(view.rounds[1]?.matches[0]?.sides[1]?.label).toBe("Winner of round 1, matchup 2");
  expect(view.champion).toBe("Winner of round 2, matchup 1");
});

test("empty, single-slot, large and malformed fields", () => {
  expect(bracketView([], teams)).toMatchObject({ slots: [], champion: null });
  expect(bracketView([slot(0, "A", null, null)], teams).champion).toBeNull();
  const large = bracketView(Array.from({ length: 17 }, (_, index) => slot(index, "A", null, null)), teams);
  expect(large.slots).toHaveLength(17);
  expect(large.slots.at(-1)?.seed).toBe(17);
  expect(() => bracketView([slot(0, "A", null, null), row(1, 0, { source_slot_a: ref("missing"), is_bye: 1 })], teams)).toThrow("Unknown published seed");
});

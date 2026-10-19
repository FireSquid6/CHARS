import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { Bracket } from "../app/seasons/[year]/bracket";
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
  const html = renderToStaticMarkup(createElement(Bracket, { bracket: view, stale: false }));
  expect(html).toContain("Charlie / Delta");
  expect(html).toContain("Seed 3");
  expect(html).not.toMatch(/<li[^>]*aria-label=/);
});

test("empty, single-slot, large and malformed fields", () => {
  expect(bracketView([], [])).toMatchObject({ slots: [], champion: null });
  expect(bracketView([slot(0, "A", null, null)], [teams[0]!]).champion).toBeNull();
  let positions = [1, 2];
  for (let size = 4; size <= 32; size *= 2) positions = positions.flatMap(seed => [seed, size + 1 - seed]);
  let entries = positions.map(seed => seed <= 17 ? ref(`main-slot-${seed}`) : null);
  const roundRows: BracketRow[] = [];
  for (let round = 1; entries.length > 1; round++) {
    const next: (string | null)[] = [];
    for (let position = 0; position < entries.length / 2; position++) {
      const first = entries[position * 2], second = entries[position * 2 + 1];
      const bye = first === null || second === null;
      roundRows.push(row(round, position, { source_slot_a: first ?? second, source_slot_b: bye ? null : second, is_bye: Number(bye) }));
      next.push(bye ? first ?? second : winner(`main-${round}-${position + 1}`));
    }
    entries = next;
  }
  const large = bracketView([...Array.from({ length: 17 }, (_, index) => slot(index, `T${index}`, null, null)), ...roundRows],
    Array.from({ length: 17 }, (_, index) => ({ id: `T${index}`, name: `Team ${index}`, abbreviation: null, category: "bid" as const })));
  expect(large.slots).toHaveLength(17);
  expect(large.slots.at(-1)?.seed).toBe(17);
  expect(() => bracketView([slot(0, "A", null, null), row(1, 0, { source_slot_a: ref("missing"), is_bye: 1 })], [teams[0]!])).toThrow("Unknown published seed");
});

test("missing or contradictory round-zero slots are invalid", () => {
  expect(() => bracketView([row(1, 0, { source_slot_a: ref("main-slot-1"), is_bye: 1 })], teams)).toThrow("Missing published round-zero");
  expect(() => bracketView([slot(0, "A", null, null)], teams)).toThrow("disagree with selected rankings");
  expect(() => bracketView([slot(0, "A", "B", "playin-1"), slot(1, "C", "D", "playin-2")], teams)).toThrow("Invalid published play-in pair");
});

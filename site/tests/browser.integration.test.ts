import { expect, test } from "bun:test";

// Start `bun site/tests/browser-fixture.ts` against a NEW /tmp/opencode/*.db first,
// then start `bun run dev -- --port 3199` with the same DATABASE_PATH and NEXT_DIST_DIR=.next-fixture.
// Never point this test at a production server: its synthetic labels and records are intentional.
const origin = process.env.SYNTHETIC_BROWSER_URL;
const integration = origin ? test : test.skip;

integration("published fixture: navigation, filtered historical statuses, bracket, and revision JSON", async () => {
  const get = async (path: string) => {
    const response = await fetch(`${origin}${path}`);
    expect(response.status).toBe(200);
    return response.text();
  };
  const home = await get("/");
  expect(home).toContain("/seasons/2020");
  const final = await get("/seasons/2020");
  expect(final).toContain("Final selection (pre-CCG)");
  expect(final).toContain("Gamma / Delta");
  expect(final).toContain("Round 1, matchup 1");
  expect(final).toContain("2020%3Aweek%3A1");
  const historical = await get("/seasons/2020?week=2020%3Aweek%3A1");
  for (const label of ["Eliminated", "Needs help", "Controls destiny", "Clinched"])
    expect(historical).toContain(label);
  const filtered = await get("/seasons/2020?week=2020%3Aweek%3A1&status=needs_help");
  expect(filtered).toMatch(/<tbody><tr>.*Delta<span/);
  expect(filtered).not.toMatch(/<tbody><tr>.*Alpha<span/);
  expect(filtered).toContain("status=needs_help");
  const response = await fetch(`${origin}/api/seasons/2020/snapshots/2020%3Aselection-final?revision=1`);
  expect(response.status).toBe(200);
  const output = await response.json() as {
    snapshot: { revision: number }; sources: { games: { id: string; revision: number }[] };
    selection: { headToHead: { rawEdges: { supportingGameIds: string[] }[] } };
    bracket: { playinPairs: { seed: number; pairId: string; teamAId: string; teamBId: string }[] };
  };
  const serialized = JSON.stringify(output);
  expect(serialized).not.toContain("CFBD_API_KEY");
  expect(serialized).not.toContain("raw_json");
  if (process.env.CFBD_API_KEY) expect(serialized).not.toContain(process.env.CFBD_API_KEY);
  expect(output.snapshot.revision).toBe(1);
  expect(output.sources.games.map(game => game.id)).toContain("fixture-game");
  expect(output.selection.headToHead.rawEdges[0]?.supportingGameIds).toEqual(["fixture-game"]);
  expect(output.bracket.playinPairs).toEqual([{ seed: 2, pairId: "pair-1", teamAId: "C", teamBId: "D" }]);
  expect(await fetch(`${origin}/api/seasons/2020/snapshots/2020%3Aselection-final?revision=999`).then(r => r.status)).toBe(404);
  expect(await fetch(`${origin}/api/seasons/2020/snapshots/2020%3Aselection-final?revision=bad`).then(r => r.status)).toBe(400);
  expect(final).not.toMatch(/<img\b|https?:\/\/[^" ]+logo|CFBD_API_KEY=[^< ]+/i);
});

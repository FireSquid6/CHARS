import { expect, test } from "bun:test";

// Start `bun site/tests/browser-fixture.ts` against a NEW /tmp/opencode/*.db first,
// then start `bun run dev -- --port 3199` with the same DATABASE_PATH and NEXT_DIST_DIR=.next-fixture.
// UI rendering fixture only, not a mathematical selection/scenario validity test.
// Never point this test at a production server.
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
    snapshot: { revision: number; publicationState: string };
    sources: { games: { id: string; revision: number }[]; poll: { availability: string;
      metadata: { sourceHash: string; releasedAtUtc: string }; entries: { teamId: string; rank: number;
        eligibleAtSnapshot: boolean }[] } };
    selection: { headToHead: { rawEdges: { supportingGameIds: string[] }[] } };
    bracket: { playinPairs: { seed: number; pairId: string; teamAId: string; teamBId: string }[] };
  };
  const serialized = JSON.stringify(output);
  expect(serialized).not.toContain("CFBD_API_KEY");
  expect(serialized).not.toContain("raw_json");
  if (process.env.CFBD_API_KEY) expect(serialized).not.toContain(process.env.CFBD_API_KEY);
  expect(output.snapshot.revision).toBe(1);
  expect(output.snapshot.publicationState).toBe("historical");
  expect(output.sources.poll.metadata).toMatchObject({ sourceHash: "original-source-1", releasedAtUtc: "2020-11-30" });
  expect(output.sources.poll.entries).toMatchObject([{ teamId: "B", rank: 1, eligibleAtSnapshot: false },
    { teamId: "C", rank: 2, eligibleAtSnapshot: true }, { teamId: "D", rank: 2, eligibleAtSnapshot: true }]);
  expect(output.sources.games.map(game => game.id)).toContain("fixture-game");
  expect(output.selection.headToHead.rawEdges[0]?.supportingGameIds).toEqual(["fixture-game"]);
  expect(output.bracket.playinPairs).toEqual([{ seed: 2, pairId: "pair-1", teamAId: "C", teamBId: "D" }]);
  const latestResponse = await fetch(`${origin}/api/seasons/2020/snapshots/2020%3Aselection-final`);
  expect(latestResponse.status).toBe(200);
  const latest = await latestResponse.json() as typeof output;
  expect(latest.snapshot).toMatchObject({ revision: 2, publicationState: "current" });
  expect(latest.sources.poll.metadata.sourceHash).toBe("original-source-2");
  expect(latest.sources.poll.entries[0]).toMatchObject({ teamId: "B", rank: 1, eligibleAtSnapshot: false });
  expect(await fetch(`${origin}/api/seasons/2020/snapshots/2020%3Aselection-final?revision=2`)
    .then(r => r.json()).then((data: typeof output) => data.sources.poll.metadata.sourceHash)).toBe("original-source-2");
  const legacyResponse = await fetch(`${origin}/api/seasons/2020/snapshots/2020%3Alegacy`);
  expect(legacyResponse.status).toBe(200);
  const legacy = await legacyResponse.json() as typeof output;
  expect(legacy.sources.poll).toMatchObject({ availability: "coverage_only", entriesAvailable: false,
    entries: null, metadata: { releaseId: "ui-poll-1", type: "cfp", timingProvenance: "fixture" } });
  expect(JSON.stringify(legacy.sources.poll)).not.toContain("corrected-later");
  expect(await fetch(`${origin}/api/seasons/2020/snapshots/2020%3Aselection-final?revision=999`).then(r => r.status)).toBe(404);
  expect(await fetch(`${origin}/api/seasons/2020/snapshots/2020%3Aselection-final?revision=bad`).then(r => r.status)).toBe(400);
  expect(final).not.toMatch(/<img\b|https?:\/\/[^" ]+logo|CFBD_API_KEY=[^< ]+/i);
});

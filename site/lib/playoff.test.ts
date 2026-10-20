import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { publishSnapshots, type SnapshotArtifact } from "../../packages/chars-db/src/snapshots";
import { currentFootballSeason, defaultSnapshot, publishedSeason, supportedSeason, verifiedFinal } from "./playoff";

const directory = mkdtempSync("/tmp/opencode/chars-playoff-test-");
const originalCache = process.env.CHARS_CACHE_PATH;
process.env.CHARS_CACHE_PATH = directory;
afterAll(() => {
  if (originalCache === undefined) delete process.env.CHARS_CACHE_PATH;
  else process.env.CHARS_CACHE_PATH = originalCache;
  rmSync(directory, { recursive: true, force: true });
});

const artifact = (key: string, kind: SnapshotArtifact["kind"], coverage: string[] = []): SnapshotArtifact =>
  ({ key, season: 2024, kind, week: 5, coverage }) as SnapshotArtifact;

test("July-June football year uses configured local timezone", () => {
  expect(currentFootballSeason(new Date("2026-07-01T04:59:59Z"))).toBe(2025);
  expect(currentFootballSeason(new Date("2026-07-01T05:00:00Z"))).toBe(2026);
  expect(currentFootballSeason(new Date("2026-07-01T00:30:00Z"), "UTC")).toBe(2026);
  expect(supportedSeason(1998, new Date("2026-01-01T00:00:00Z"))).toBe(true);
  expect(supportedSeason(2026, new Date("2026-01-01T00:00:00Z"))).toBe(false);
  expect(supportedSeason(1997)).toBe(false);
});

test("only clean published finals win the default and license a bracket", () => {
  const week = artifact("week", "week_final");
  const badFinal = artifact("bad-final", "selection_final", ["calendar not verified"]);
  const goodFinal = artifact("final", "selection_final");
  expect(verifiedFinal(badFinal)).toBe(false);
  expect(defaultSnapshot([week, badFinal])).toBe(badFinal);
  expect(defaultSnapshot([week, goodFinal, badFinal])).toBe(goodFinal);
  expect(defaultSnapshot([week])).toBe(week);
});

test("published cache is read without a database or provider call; absent cache is a setup state", async () => {
  expect((await publishedSeason(2023)).issue).toContain("No published snapshots");
  await publishSnapshots(join(directory, "snapshots"), 2024, [artifact("week", "week_final")]);
  const result = await publishedSeason(2024);
  expect(result.issue).toBeNull();
  expect(result.snapshots.map(snapshot => snapshot.key)).toEqual(["week"]);
});

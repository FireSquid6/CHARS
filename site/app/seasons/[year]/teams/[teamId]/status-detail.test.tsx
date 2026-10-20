import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { SnapshotArtifact } from "../../../../../../packages/chars-db/src/snapshots";
import type { ScenarioProof } from "../../../../../../packages/chars-algorithm/src/index";
import { StatusDetail } from "./status-detail";

const row = ({ teamId: "team", colleyRank: 12, colleyRating: 0.625, record: { wins: 1, losses: 1, ties: 0, percentageNumerator: 2, percentageDenominator: 4 }, eligible: false, originalRoute: "outside", finalCategory: "outside", adjustedRank: null }) as SnapshotArtifact["playoff"]["seeding"]["rankings"][number];
const proof: ScenarioProof = { snapshotKey: "snapshot", snapshotRevision: 0, teamId: "team", pollModelVersion: "test", solverVersion: "test",
  runtimeMs: 1, state: "proved", label: "needs_help", proofMetadata: JSON.stringify({ pollDependent: true }), assumptions: ["fixed schedule"],
  witnesses: [{ kind: "qualifying_win_out", gameOutcomes: { "game-1": "home", "game-2": "tie" }, pollOrderTeamIds: ["team"], assumptions: ["one possible path"] }] };

test("team detail labels witnesses as examples without claiming today's record eliminates a team", () => {
  const html = renderToStaticMarkup(<StatusDetail row={row} proof={proof} final={false} incomplete={false} />);
  expect(html).toContain("Needs help");
  expect(html).toContain("one possible path");
  expect(html).toContain("not a necessary or sufficient condition");
  expect(html).toContain("Poll-dependent");
  expect(html).toContain("game-2: tie");
  expect(html).toContain("not a mathematical elimination proof");
});

test("incomplete snapshots do not display cached proofs or witnesses", () => {
  const html = renderToStaticMarkup(<StatusDetail row={row} proof={proof} final={false} incomplete={true} />);
  expect(html).toContain("Data incomplete — no status proof");
  expect(html).not.toContain("Qualifying win-out completion");
});

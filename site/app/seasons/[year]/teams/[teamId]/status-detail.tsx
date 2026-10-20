import type { ScenarioProof } from "../../../../../../packages/chars-algorithm/src/index";
import type { SnapshotArtifact } from "../../../../../../packages/chars-db/src/snapshots";

type Ranking = SnapshotArtifact["playoff"]["seeding"]["rankings"][number];

const labels = {
  clinched: "Clinched",
  eliminated: "Eliminated",
  controls_destiny: "Controls destiny",
  needs_help: "Needs help"
} as const;

const witnessNames = {
  qualifying: "Qualifying completion",
  failing: "Nonqualifying completion",
  qualifying_win_out: "Qualifying win-out completion",
  failing_win_out: "Nonqualifying win-out completion"
} as const;

export function StatusDetail({ row, proof, final, incomplete }: { row: Ranking; proof: ScenarioProof | null; final: boolean; incomplete: boolean }) {
  const metadata = proof?.proofMetadata ? JSON.parse(proof.proofMetadata) as { exception?: string; pollDependent?: boolean } : null;
  const proved = proof?.state === "proved" && proof.label !== null && !incomplete;
  const status = final ? "Final selection" : incomplete ? "Data incomplete — no status proof" :
    proved ? labels[proof.label!] : metadata?.exception ? "Policy/model exception — no four-bubble label" :
      proof?.state === "unsupported" ? "Computation unsupported" : "Pending / unproved";

  return <section className="snapshot-summary" aria-labelledby="team-selection-heading">
    <h2 id="team-selection-heading">Snapshot selection &amp; status</h2>
    <p><strong>{status}</strong> · Colley #{row.colleyRank} ({row.colleyRating.toFixed(6)}) · {row.record.wins}–{row.record.losses}{row.record.ties ? `–${row.record.ties}` : ""} · {row.record.percentageDenominator ? (row.record.percentageNumerator / row.record.percentageDenominator).toFixed(3) : "no completed games"}.</p>
    <p>{row.eligible ? "Currently eligible for provisional selection" : "Currently outside the .750 minimum (not a mathematical elimination proof)"} · Initial route: {row.originalRoute.replaceAll("_", " ")} · Final category at this snapshot: {row.finalCategory === "bid" ? "direct bid" : row.finalCategory === "playin" ? "play-in" : "outside"}{row.adjustedRank ? ` · Adjusted selected-team rank #${row.adjustedRank}` : ""}.</p>
    {!final && <>
      <p>Future-status claims assume the fixed known remaining schedule and all eligible future poll orders. A witness is <strong>one possible path</strong>, not a necessary or sufficient condition for selection. Today&apos;s .750 failure does not prove end-of-season elimination.</p>
      {metadata?.exception && <p className="notice">This result cannot be assigned one of the four mathematical bubbles under the current model. {metadata.exception}</p>}
      {metadata?.pollDependent && <p>Poll-dependent: eligible voter choices can change the outcome even when this team wins out. No particular win alone guarantees selection.</p>}
      {proof?.assumptions.length ? <div><h3>Proof assumptions</h3><ul>{proof.assumptions.map((assumption, index) => <li key={index}>{assumption}</li>)}</ul></div> : null}
      {proof?.witnesses.length && !incomplete ? <div><h3>One possible path per witness</h3><ul className="witness-list">{proof.witnesses.map((witness, index) => <li key={`${witness.kind}-${index}`}><strong>{witnessNames[witness.kind]}</strong><p>Future game IDs and outcomes: {Object.entries(witness.gameOutcomes).map(([gameId, outcome]) => `${gameId}: ${outcome === "tie" ? "tie" : `${outcome} wins`}`).join("; ") || "no remaining games"}.</p><p>Eligible poll order (team IDs): {witness.pollOrderTeamIds.join(" › ") || "none"}.</p>{witness.assumptions.length > 0 && <p>Path assumptions: {witness.assumptions.join("; ")}.</p>}</li>)}</ul></div> : <p>{incomplete ? "No witness can be displayed while snapshot data is incomplete." : "No qualifying or failing witness is published for this team at this snapshot."}</p>}
    </>}
  </section>;
}

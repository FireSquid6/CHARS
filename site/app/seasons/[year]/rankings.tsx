"use client";

import Link from "next/link";
import { useState } from "react";
import type { SnapshotArtifact } from "../../../../packages/chars-db/src/snapshots";
import type { TeamIdentity } from "../../../lib/playoff";
import type { ScenarioProof, ScenarioLabel } from "../../../../packages/chars-algorithm/src/index";

type Ranking = SnapshotArtifact["playoff"]["seeding"]["rankings"][number];

const labels: { label: ScenarioLabel; text: string }[] = [
  { label: "eliminated", text: "Eliminated" }, { label: "needs_help", text: "Needs help" },
  { label: "controls_destiny", text: "Controls destiny" }, { label: "clinched", text: "Clinched" }
];

export function Rankings({ year, rows, identities, final, proofs, incomplete }: { year: number; rows: Ranking[]; identities: Record<string, TeamIdentity>; final: boolean; proofs: ScenarioProof[]; incomplete: boolean }) {
  const [all, setAll] = useState(false);
  const [search, setSearch] = useState("");
  const [bubble, setBubble] = useState<ScenarioLabel | null>(null);
  const byTeam = new Map(proofs.map(proof => [proof.teamId, proof]));
  const visible = rows.filter(row => (!bubble || byTeam.get(row.teamId)?.label === bubble) && (all || row.eligible) &&
    `${identities[row.teamId]?.teamName ?? row.teamId} ${row.teamId} ${identities[row.teamId]?.abbreviation ?? ""}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  return <section className="listing" aria-labelledby="rankings-heading">
    <div className="section-title"><div><p className="kicker">FULL FBS MATRIX</p><h2 id="rankings-heading">Rankings &amp; selection</h2></div><p>{rows.length} FBS teams</p></div>
    {!final && <div className="bubble-group" aria-label="Mathematical status filters">
      {labels.map(({ label, text }) =>
        <button key={label} type="button" aria-pressed={bubble === label} onClick={() => setBubble(bubble === label ? null : label)}>{text} <strong>{proofs.filter(proof => proof.state === "proved" && proof.label === label).length}</strong></button>)}
      <p>{proofs.filter(proof => proof.state === "proved").length} proved · {rows.length - proofs.filter(proof => proof.state === "proved").length} {incomplete ? "data incomplete" : "pending/unproved or policy exception"}. Fixed schedule; all eligible poll orders. A current .750 exclusion is not elimination.</p>
    </div>}
    <div className="filter-bar"><label htmlFor="team-search">Search teams</label><input id="team-search" type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Team or abbreviation" />
      <label className="toggle"><input type="checkbox" checked={all} onChange={event => setAll(event.target.checked)} /> Include ineligible teams</label></div>
    <p className="subtle">Showing {visible.length} of {rows.length} FBS teams. .750 minimum requires at least one completed regular-season game; rating boundaries apply to initial selection only. Swaps may change the final category without changing a rating.</p>
    <div className="table-scroll"><table><caption className="sr-only">FBS Colley rankings and hypothetical playoff selection</caption><thead><tr><th scope="col">Colley #</th><th scope="col">Team</th><th scope="col">Record / pct</th><th scope="col">Rating</th><th scope="col">Adjusted #</th><th scope="col">Initial route</th><th scope="col">Final category</th>{!final && <th scope="col">Scenario status</th>}</tr></thead><tbody>
      {visible.map(row => { const name = identities[row.teamId]?.teamName ?? row.teamId;
        const record = row.record;
        return <tr key={row.teamId}><td>{row.colleyRank}</td><th scope="row"><Link className="primary-link" href={`/seasons/${year}/teams/${encodeURIComponent(row.teamId)}`}>{name}</Link><span className="subtext">{identities[row.teamId]?.abbreviation ?? row.teamId}{identities[row.teamId]?.conference ? ` · ${identities[row.teamId]?.conference}` : ""}</span></th>
          <td>{record.wins}–{record.losses}{record.ties ? `–${record.ties}` : ""} · {record.percentageDenominator ? (record.percentageNumerator / record.percentageDenominator).toFixed(3) : "—"}{!row.eligible && <span className="subtext">Excluded: {record.percentageDenominator ? "below .750" : "no games"}</span>}</td>
           <td className="score-cell">{row.colleyRating.toFixed(6)}</td><td>{row.adjustedRank ?? "—"}</td><td>{row.originalRoute.replaceAll("_", " ")}</td><td><span className={`category category-${row.finalCategory}`}>{row.finalCategory === "playin" ? "Play-in" : row.finalCategory === "bid" ? "Direct bid" : "Outside"}</span></td>{!final && <td>{incomplete ? "Data incomplete" : (() => { const proof = byTeam.get(row.teamId); const label = labels.find(item => item.label === proof?.label)?.text; const metadata = proof?.proofMetadata ? JSON.parse(proof.proofMetadata) as { exception?: string; pollDependent?: boolean } : null; return <>{label ?? (metadata?.exception ? "Policy/model exception" : proof?.state === "unsupported" ? "Computation unsupported" : "Pending proof")}{proof?.witnesses.length ? <details><summary>Possible paths and assumptions</summary><ul>{proof.witnesses.map(witness => <li key={witness.kind}>{witness.kind.replaceAll("_", " ")}: {Object.entries(witness.gameOutcomes).map(([id, outcome]) => `${id} ${outcome}`).join(", ") || "no remaining games"}; eligible poll order: {witness.pollOrderTeamIds.join(" > ") || "empty"}. One possible path, not a guarantee.</li>)}</ul><p>{metadata?.pollDependent ? "Poll-dependent: eligible voter order changes the win-out outcome." : "All eligible poll orders considered for proved claims."}</p></details> : null}</>; })()}</td>}</tr>;
      })}
    </tbody></table>{visible.length === 0 && <p className="empty">No teams match these filters.</p>}</div>
  </section>;
}

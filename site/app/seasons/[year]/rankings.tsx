"use client";

import Link from "next/link";
import { useState } from "react";
import type { SnapshotArtifact } from "../../../../packages/chars-db/src/snapshots";
import type { TeamIdentity } from "../../../lib/playoff";

type Ranking = SnapshotArtifact["playoff"]["seeding"]["rankings"][number];

export function Rankings({ year, rows, identities, final }: { year: number; rows: Ranking[]; identities: Record<string, TeamIdentity>; final: boolean }) {
  const [all, setAll] = useState(false);
  const [search, setSearch] = useState("");
  const [bubble, setBubble] = useState<string | null>(null);
  const visible = bubble ? [] : rows.filter(row => (all || row.eligible) &&
    `${identities[row.teamId]?.teamName ?? row.teamId} ${row.teamId} ${identities[row.teamId]?.abbreviation ?? ""}`.toLocaleLowerCase().includes(search.toLocaleLowerCase()));
  return <section className="listing" aria-labelledby="rankings-heading">
    <div className="section-title"><div><p className="kicker">FULL FBS MATRIX</p><h2 id="rankings-heading">Rankings &amp; selection</h2></div><p>{rows.length} FBS teams</p></div>
    {!final && <div className="bubble-group" aria-label="Mathematical status filters">
      {(["Eliminated", "Needs help", "Controls destiny", "Clinched"] as const).map(label =>
        <button key={label} type="button" aria-pressed={bubble === label} onClick={() => setBubble(bubble === label ? null : label)}>{label} <strong>0</strong></button>)}
      <p>0 proved · {rows.length} pending/unproved. Fixed-schedule, all eligible poll orders: no exact scenario proofs published. A current .750 exclusion is not elimination.</p>
    </div>}
    <div className="filter-bar"><label htmlFor="team-search">Search teams</label><input id="team-search" type="search" value={search} onChange={event => setSearch(event.target.value)} placeholder="Team or abbreviation" />
      <label className="toggle"><input type="checkbox" checked={all} onChange={event => setAll(event.target.checked)} /> Include ineligible teams</label></div>
    <p className="subtle">Showing {visible.length} of {rows.length} FBS teams. .750 minimum requires at least one completed regular-season game; rating boundaries apply to initial selection only. Swaps may change the final category without changing a rating.</p>
    <div className="table-scroll"><table><caption className="sr-only">FBS Colley rankings and hypothetical playoff selection</caption><thead><tr><th scope="col">Colley #</th><th scope="col">Team</th><th scope="col">Record / pct</th><th scope="col">Rating</th><th scope="col">Adjusted #</th><th scope="col">Initial route</th><th scope="col">Final category</th>{!final && <th scope="col">Scenario status</th>}</tr></thead><tbody>
      {visible.map(row => { const name = identities[row.teamId]?.teamName ?? row.teamId;
        const record = row.record;
        return <tr key={row.teamId}><td>{row.colleyRank}</td><th scope="row"><Link className="primary-link" href={`/seasons/${year}/teams/${encodeURIComponent(row.teamId)}`}>{name}</Link><span className="subtext">{identities[row.teamId]?.abbreviation ?? row.teamId}{identities[row.teamId]?.conference ? ` · ${identities[row.teamId]?.conference}` : ""}</span></th>
          <td>{record.wins}–{record.losses}{record.ties ? `–${record.ties}` : ""} · {record.percentageDenominator ? (record.percentageNumerator / record.percentageDenominator).toFixed(3) : "—"}{!row.eligible && <span className="subtext">Excluded: {record.percentageDenominator ? "below .750" : "no games"}</span>}</td>
          <td className="score-cell">{row.colleyRating.toFixed(6)}</td><td>{row.adjustedRank ?? "—"}</td><td>{row.originalRoute.replaceAll("_", " ")}</td><td><span className={`category category-${row.finalCategory}`}>{row.finalCategory === "playin" ? "Play-in" : row.finalCategory === "bid" ? "Direct bid" : "Outside"}</span></td>{!final && <td>Pending proof</td>}</tr>;
      })}
    </tbody></table>{visible.length === 0 && <p className="empty">No teams match these filters.</p>}</div>
  </section>;
}

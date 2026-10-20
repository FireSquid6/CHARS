import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { parseYear } from "../../../lib/archive";
import { defaultSnapshot, publishedSeason, supportedSeason, teamIdentities, verifiedFinal } from "../../../lib/playoff";
import { WeekControls } from "./week-controls";
import { Rankings } from "./rankings";
import { Bracket } from "./bracket";
import { readScenarioResult } from "../../../../packages/chars-db/src/scenarios";

export default async function SeasonPage({ params, searchParams }: PageProps<"/seasons/[year]">) {
  const { year: rawYear } = await params;
  const year = parseYear(rawYear);
  if (year === null || !supportedSeason(year)) notFound();
  await connection();
  const { snapshots, issue } = await publishedSeason(year);
  const query = await searchParams;
  const requested = typeof query.week === "string" ? query.week : undefined;
  const fallback = defaultSnapshot(snapshots);
  const snapshot = requested ? snapshots.find(item => item.key === requested) : fallback;
  const identities = snapshot ? teamIdentities(year) : {};
  const final = snapshot ? verifiedFinal(snapshot) : false;
  const rows = snapshot?.playoff.seeding.rankings ?? [];
  const scenarios = snapshot && !final && !snapshot.coverage.length ? await readScenarioResult(snapshot) : null;
  return <main className="container content-page">
    <nav className="breadcrumbs" aria-label="Breadcrumb"><Link href="/">Seasons</Link><span aria-hidden="true">/</span><span aria-current="page">{year}</span></nav>
    <div className="page-heading"><div><p className="kicker">THE {year} SEASON</p><h1>{year} <em>playoff.</em></h1><p className="intro">FBS-only computed Colley ratings and a hypothetical selection field, frozen at the declared snapshot cutoff.</p></div><div className="heading-stat"><strong>{rows.length}</strong><span>FBS TEAMS</span></div></div>
    {snapshots.length > 0 && fallback && <WeekControls year={year} selected={snapshot?.key ?? fallback.key} defaultKey={fallback.key} keys={snapshots.map(item => ({ key: item.key, label: `${item.kind === "selection_final" ? "Final selection" : item.kind === "partial" ? "Partial week" : `Week ${item.week ?? "?"}`}${item.coverage.length ? " · data gaps" : ""}` }))} />}
    {requested && !snapshot && <p role="alert" className="notice">This snapshot key is not published for {year}. Choose a published week or return to latest/final.</p>}
    {!snapshot ? <section className="notice" aria-label="Data setup state"><h2>Snapshot unavailable</h2><p>{issue ?? "No published snapshots are available for this selection."}</p><p>Missing results or a calendar verification cannot establish a final field.</p></section> : <>
      <section className="snapshot-summary" aria-label="Snapshot details"><h2>{final ? "Final selection" : "Provisional selection"} · {snapshot.kind === "selection_final" ? "pre-CCG" : `week ${snapshot.week ?? "partial"}`}</h2>
        <p>Games through <time dateTime={snapshot.gameCutoffUtc}>{snapshot.gameCutoffUtc}</time> · Poll: {snapshot.pollPolicy} {snapshot.pollReleaseId ? `(${snapshot.pollReleaseId})` : "(no verified release)"} · {snapshot.includedGameIds.length} included games.</p>
        <p>Model: {snapshot.modelVersion} · Selection: {snapshot.policyVersion} · Calendar: {snapshot.calendarPolicyVersion}. Source revision: {snapshot.sourceHash.slice(0, 12)}.</p>
        {snapshot.coverage.length > 0 && <div className="notice"><strong>Data incomplete — no verified final bracket.</strong><ul>{snapshot.coverage.map((gap, index) => <li key={index}>{gap}</li>)}</ul></div>}
         {!final && <p className="notice">Selection is provisional, not a final bracket. Scenario analysis: {snapshot.coverage.length ? "data incomplete" : scenarios?.complete ? "exhaustive or certified" : scenarios?.pendingReason ?? "pending/unproved"}. Proofs assume a fixed schedule and all eligible poll orders; current .750 exclusion is not elimination.</p>}
      </section>
      <section className="boundary-notes" aria-label="Selection rules and audit"><h2>How the field was selected</h2><p>Eligible record ≥ .750 · initial direct bid rating ≥ .90 (then highest eligible teams to a minimum of four) · initial play-in rating ≥ .85 · eligible contemporaneous {snapshot.pollPolicy} additions toward 12. The field may remain short or exceed 12. Thresholds do not change a team’s Colley rating after a head-to-head swap.</p>
        <p>Initial: {snapshot.playoff.counts.initialBid} direct bids, {snapshot.playoff.counts.initialPlayin} play-ins. After swaps: {snapshot.playoff.counts.bid} direct bids, {snapshot.playoff.counts.playin} play-ins.</p>
        {snapshot.playoff.seeding.swaps.length ? <ol>{snapshot.playoff.seeding.swaps.map(swap => <li key={swap.sequence}>{identities[swap.winnerTeamId]?.teamName ?? swap.winnerTeamId} replaced {identities[swap.loserTeamId]?.teamName ?? swap.loserTeamId} ({swap.winnerBefore} → {swap.loserBefore}); supporting game IDs: {swap.supportingGameIds.join(", ")}.</li>)}</ol> : <p>No selection-category head-to-head swaps.</p>}
        {snapshot.playoff.seeding.selection.unappliedOutsiderBidClaims.length > 0 && <p>Outsider claims against direct bids without a play-in admission: {snapshot.playoff.seeding.selection.unappliedOutsiderBidClaims.map(edge => `${identities[edge.winnerTeamId]?.teamName ?? edge.winnerTeamId} over ${identities[edge.loserTeamId]?.teamName ?? edge.loserTeamId}`).join("; ")}.</p>}
        {snapshot.playoff.seeding.cyclicGroups.length > 0 && <p>Head-to-head cycle fallback to Colley: {snapshot.playoff.seeding.cyclicGroups.map(group => group.map(id => identities[id]?.teamName ?? id).join(" / ")).join("; ")}.</p>}
        {snapshot.playoff.shortFieldExplanation && <p>{snapshot.playoff.shortFieldExplanation}</p>}
      </section>
       <Rankings key={snapshot.key} year={year} rows={rows} identities={identities} final={final} proofs={scenarios?.proofs ?? []} incomplete={snapshot.coverage.length > 0} />
      {final && <Bracket playoff={snapshot.playoff} identities={identities} />}
    </>}
  </main>;
}

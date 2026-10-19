import Link from "next/link";
import { notFound } from "next/navigation";
import { filterRankings, getSeasonData, supportedYears, type Ranking, type SnapshotOption } from "@/lib/season-data";
import { Bracket } from "./bracket";
import { RankingControls, SnapshotControls } from "./controls";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const routeLabels: Record<string, string> = {
  rating_bid: "≥ .90 direct bid", colley_minimum_bid: "Minimum-four bid",
  rating_playin: "≥ .85 play-in", poll_playin: "AP/CFP poll addition", outside: "Outside",
};

function label(option: SnapshotOption) {
  if (option.kind === "selection_final") return "Final selection (pre-CCG)";
  if (option.key.endsWith(":preseason")) return "Preseason";
  return `Week ${option.week}${option.kind === "partial" ? " · partial" : " · complete"}`;
}

function percentage(team: Ranking): string {
  const games = team.wins + team.losses + team.ties;
  return games ? ((team.wins + team.ties / 2) / games).toFixed(3) : "—";
}

function formatDate(value: string) {
  return new Date(value).toLocaleString("en-US", { timeZone: "America/Chicago", dateStyle: "medium", timeStyle: "short" });
}

export default async function SeasonPage({ params, searchParams }: {
  params: Promise<{ year: string }>;
  searchParams: Promise<{ week?: string; q?: string; view?: string }>;
}) {
  const { year: yearText } = await params;
  const year = Number(yearText);
  if (!/^\d{4}$/.test(yearText) || !supportedYears().includes(year)) notFound();
  const query = await searchParams;
  const week = typeof query.week === "string" ? query.week : undefined;
  const data = getSeasonData(year, week);
  const selected = data.snapshot;
  const search = typeof query.q === "string" ? query.q.trim().slice(0, 100) : "";
  const eligibleOnly = query.view === "eligible";
  const visible = filterRankings(data.rankings, search, eligibleOnly);
  const names = new Map(data.rankings.map(team => [team.teamId, team.name]));
  const base = `/seasons/${year}`;
  return (
    <main className="shell">
      <Link href="/" className="back">← All seasons</Link>
      <header className="masthead">
        <p className="eyebrow">Season archive / {year}</p>
        <h1>{year} rankings</h1>
        <p>FBS-only Colley model · regular-season results through the selected cutoff. Historical weeks are retrospective reconstructions, not archived contemporary API responses.</p>
        <div className="summary"><span className={`badge ${data.state}`}>{data.state === "incomplete" ? "Data incomplete" : data.state}</span>
          {selected && <span>{label(selected)} · Revision {selected.revision}</span>}</div>
      </header>
      {data.issue && <aside className="notice" role="status"><strong>Data unavailable</strong><p>{data.issue}</p>
        {!process.env.CFBD_API_KEY && <p>Set CFBD_API_KEY on the server to ingest data; no historical rankings are inferred without stored results.</p>}</aside>}
      {data.pending && <aside className="notice" role="status"><strong>Update pending</strong>
        <p>New source data are awaiting a validated snapshot. Displayed results, if any, are the last published revision.</p></aside>}
      {data.options.length > 0 && <SnapshotControls base={base} options={data.options} selected={selected?.key} search={search} view={eligibleOnly ? "eligible" : "all"} />}
      {selected && <>
        <div className="summary"><span>Games through {formatDate(selected.gameCutoff)}</span>
          <span>· Published {formatDate(selected.publishedAt)}</span>
          {selected.coverage.poll && <span>· {selected.coverage.poll.type.toUpperCase()} poll{selected.coverage.poll.fallback ? " (early-season fallback)" : ""}</span>}
          {data.lastSync && <span>· Last successful site-wide sync {formatDate(data.lastSync)}</span>}</div>
        {(selected.publicationState !== "current" || !selected.coverage.complete) &&
          <aside className="notice" role="status"><strong>{selected.publicationState === "current" ? "Incomplete snapshot" : `${selected.publicationState} publication`}</strong>
             <p>{selected.publicationState !== "current" ? "Showing a retained published revision; underlying inputs may have changed. This is not a validated current result. " : ""}
               {selected.coverage.reasons.length ? selected.coverage.reasons.join("; ") : selected.publicationState === "current" ?
                 "Data coverage is incomplete." : "Awaiting a validated replacement."}</p>
          </aside>}
        <section className="rules" aria-label="Selection rules">
          <p><strong>Selection:</strong> Teams need at least .750 regular-season winning percentage and at least one game. Ratings ≥ .90 earn initial direct bids; if fewer than four, the next eligible teams fill the minimum four. Remaining eligible teams ≥ .85 enter play-ins; contemporaneous AP/CFP poll entries fill toward twelve when available. The field may be short.</p>
          <p>Head-to-head swaps can move teams between categories without changing their Colley rating. No single rating line describes the final field. Ties count as half a win; FCS wins count toward eligibility but not the FBS-only Colley matrix.</p>
        </section>
        {selected.kind !== "selection_final" && <section className="status-pending" aria-label="Mathematical status pending">
          <h2>Playoff status · pending computation</h2><p>Eliminated · Needs help · Controls destiny · Clinched: no mathematical classifications are published for this snapshot. Provisional selections below are not elimination or clinch proofs.</p>
        </section>}
        {data.bracket && <Bracket bracket={data.bracket} stale={selected.publicationState === "stale"} />}
        {data.bracketIssue && <aside className="notice" role="status"><strong>Bracket unavailable</strong><p>{data.bracketIssue} Rankings and snapshot controls remain available.</p></aside>}
        <section aria-labelledby="ranking-title">
          <div className="section-head"><h2 id="ranking-title">{eligibleOnly ? "Eligible FBS rankings" : "All FBS teams"}</h2><span>{visible.length} shown · {data.rankings.length} FBS teams</span></div>
          <RankingControls base={base} week={selected.key} search={search} eligibleOnly={eligibleOnly} />
          <div className="table-wrap" role="region" aria-label="Scrollable FBS rankings" tabIndex={0}>
            <table><caption className="sr-only">Published Colley rankings and selection categories</caption>
              <thead><tr><th scope="col">Raw rank</th><th scope="col">Team</th><th scope="col">Adjusted</th><th scope="col">Rating</th>
                <th scope="col">W–L–T</th><th scope="col">Pct</th><th scope="col">Selection category</th><th scope="col">Initial route / reason</th></tr></thead>
              <tbody>{visible.map(team => <tr key={team.teamId}>
                <td>{team.colleyRank}</td><th scope="row" className="team">{team.name}{team.abbreviation && <span className="subtle"> ({team.abbreviation})</span>}</th>
                <td>{team.adjustedRank ?? "—"}</td><td>{team.rating.toFixed(6)}</td>
                <td>{team.wins}–{team.losses}–{team.ties}</td><td>{percentage(team)}</td>
                 <td><span className={`badge ${team.finalCategory}`}>{selected.kind === "selection_final" && selected.coverage.complete ? selected.publicationState === "stale" ? "Retained final · " : selected.publicationState === "current" ? "Final · " : "Provisional · " : "Provisional · "}{team.finalCategory === "playin" ? "Play-in" : team.finalCategory === "bid" ? "Direct bid" : "Outside"}</span></td>
                <td className="explanation">{routeLabels[team.originalRoute] ?? team.originalRoute}{!team.eligible ? ` · ${team.eligibilityReason ?? "Below .750"}` : ""}</td>
              </tr>)}</tbody>
            </table>{visible.length === 0 && <p className="empty">No matching teams in this view.</p>}
          </div>
        </section>
        {data.swaps.length > 0 && <section className="audit" aria-labelledby="swaps-heading"><h2 id="swaps-heading">Head-to-head swaps</h2>
          <ol>{data.swaps.map(swap => <li key={swap.sequence}>{names.get(swap.winner) ?? swap.winner} moves from {swap.winnerBefore} over {names.get(swap.loser) ?? swap.loser} ({swap.loserBefore}); supporting game IDs: {swap.supportingGameIds.join(", ") || "not recorded"}.</li>)}</ol>
        </section>}
      </>}
    </main>
  );
}

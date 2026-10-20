import Link from "next/link";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { getSchedule, getTeam, parseYear } from "../../../../../lib/archive";
import { formatGameDate } from "../../../../../lib/format-date";
import { defaultSnapshot, publishedSeason, supportedSeason, teamIdentities, verifiedFinal } from "../../../../../lib/playoff";
import { seasonHref, teamHref } from "../../../../../lib/season-links";
import { readScenarioResult, scenarioCoverageReady } from "../../../../../../packages/chars-db/src/scenarios";
import { StatusDetail } from "./status-detail";

export default async function TeamPage({ params, searchParams }: PageProps<"/seasons/[year]/teams/[teamId]">) {
  const { year: rawYear, teamId } = await params;
  const year = parseYear(rawYear);
  if (year === null || !supportedSeason(year)) notFound();
  await connection();
  const { snapshots, issue } = await publishedSeason(year);
  const query = await searchParams;
  const requested = typeof query.week === "string" ? query.week : undefined;
  const snapshot = requested ? snapshots.find(item => item.key === requested) : defaultSnapshot(snapshots);
  const row = snapshot?.playoff.seeding.rankings.find(ranking => ranking.teamId === teamId);
  const identities = snapshot ? teamIdentities(year) : {};
  const name = identities[teamId]?.teamName ?? teamId;
  const incomplete = snapshot ? !scenarioCoverageReady(snapshot.coverage) : true;
  const scenarios = snapshot && row && !verifiedFinal(snapshot) && !incomplete ? await readScenarioResult(snapshot) : null;
  // The legacy schedule is a full-season view, not the selected snapshot's game set.
  let team = null;
  let schedule: ReturnType<typeof getSchedule> | null = null;
  if (process.env.DATABASE_PATH) {
    try {
      team = getTeam(year, teamId);
      if (team) schedule = getSchedule(year, teamId);
    } catch { /* Snapshot detail remains usable if the legacy SQLite schedule is unavailable. */ }
  }
  if (snapshot && !row && !team) notFound();
  const back = seasonHref(year, requested);
  return <main className="container content-page">
    <nav className="breadcrumbs" aria-label="Breadcrumb"><Link href="/">Seasons</Link><span aria-hidden="true">/</span><Link href={back}>{year}</Link><span aria-hidden="true">/</span><span aria-current="page">{name}</span></nav>
    <div className="page-heading"><div><p className="kicker">{year} · {team?.conference ?? identities[teamId]?.conference ?? "FBS"}</p><h1>{name}<em className="period">.</em></h1><p className="intro">Selection details for the chosen snapshot and the separate full imported season schedule.</p></div>{row && <div className="heading-stat record-stat"><strong>{row.record.wins}–{row.record.losses}{row.record.ties ? `–${row.record.ties}` : ""}</strong><span>RECORD AT SNAPSHOT</span></div>}</div>
    {requested && !snapshot && <p role="alert" className="notice">This snapshot key is not published for {year}. <Link href={seasonHref(year)}>Return to latest/final.</Link></p>}
    {snapshot ? <>
      <p className="subtle">{verifiedFinal(snapshot) ? "Verified final selection" : "Provisional selection"} · {snapshot.kind === "selection_final" ? "pre-CCG" : snapshot.kind === "partial" ? "partial week" : `week ${snapshot.week ?? "?"}`} · snapshot {snapshot.key}.</p>
      {row ? <StatusDetail row={row} proof={scenarios?.proofs.find(proof => proof.teamId === teamId) ?? null} final={verifiedFinal(snapshot)} incomplete={incomplete} /> : <p className="notice">This team is not in the selected FBS snapshot; only the imported schedule is available.</p>}
      {snapshot.coverage.length > 0 && <div className="notice"><strong>Snapshot coverage / timing notes</strong><ul>{snapshot.coverage.map((gap, index) => <li key={index}>{gap}</li>)}</ul></div>}
    </> : <section className="notice" aria-label="Data setup state"><h2>Snapshot unavailable</h2><p>{issue ?? "No published snapshot is available for this season."}</p><p>Without a published snapshot, no playoff field or mathematical status can be asserted.</p></section>}
    {schedule ? <section className="listing" aria-labelledby="schedule-heading"><div className="section-title"><div><p className="kicker">FULL IMPORTED SEASON · NOT SNAPSHOT-SCOPED</p><h2 id="schedule-heading">The schedule</h2></div><p>{schedule.length} games <span aria-hidden="true">↘</span></p></div>
      <div className="table-scroll"><table><thead><tr><th scope="col">Week</th><th scope="col">Date</th><th scope="col">Matchup</th><th scope="col">Score</th><th scope="col">Result</th></tr></thead><tbody>
        {schedule.map(game => {
          const played = game.teamScore !== null && game.opponentScore !== null;
          const result = !played ? "Upcoming" : game.teamScore! > game.opponentScore! ? "W" : game.teamScore! < game.opponentScore! ? "L" : "T";
          return <tr key={game.gameId}><td className="muted">{game.week}</td><td className="date-cell">{formatGameDate(game.startDate)}</td><th scope="row"><span className="matchup-prefix">{game.home ? "vs" : "at"}</span> {game.opponentClass === "FBS" ? <Link className="primary-link" href={teamHref(year, game.opponentId, requested)}>{game.opponentName} <span className="arrow" aria-hidden="true">↗</span></Link> : <span>{game.opponentName}</span>}{game.opponentClass && game.opponentClass !== "FBS" && <span className="subtext">{game.opponentClass}</span>}</th><td className="score-cell">{played ? `${game.teamScore} – ${game.opponentScore}${game.overtimes ? ` (${game.overtimes} OT)` : ""}` : "—"}</td><td><span className={`result result-${result.toLowerCase()}`}>{result}</span></td></tr>;
        })}
      </tbody></table>{schedule.length === 0 && <p className="empty">No games are scheduled for this team yet.</p>}</div>
    </section> : <p className="notice">Full imported schedule unavailable. Configure DATABASE_PATH and load this season to view game details.</p>}
    <Link className="back-link" href={back}>← Back to {year} rankings</Link>
  </main>;
}

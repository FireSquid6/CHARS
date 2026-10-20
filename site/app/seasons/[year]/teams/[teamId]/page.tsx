import Link from "next/link";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { getSchedule, getTeam, parseYear } from "../../../../../lib/archive";
import { formatGameDate } from "../../../../../lib/format-date";

export default async function TeamPage({ params }: PageProps<"/seasons/[year]/teams/[teamId]">) {
  const { year: rawYear, teamId } = await params;
  const year = parseYear(rawYear);
  if (year === null) notFound();
  await connection();
  const team = getTeam(year, teamId);
  if (!team) notFound();
  const schedule = getSchedule(year, teamId);

  return (
    <main className="container content-page">
      <nav className="breadcrumbs" aria-label="Breadcrumb"><Link href="/">Seasons</Link><span aria-hidden="true">/</span><Link href={`/seasons/${year}`}>{year}</Link><span aria-hidden="true">/</span><span aria-current="page">{team.teamName}</span></nav>
      <div className="page-heading"><div><p className="kicker">{year} · {team.conference}</p><h1>{team.teamName}<em className="period">.</em></h1><p className="intro">Regular-season schedule and results for the {year} {team.teamName}.</p></div><div className="heading-stat record-stat"><strong>{team.wins}–{team.losses}{team.ties ? `–${team.ties}` : ""}</strong><span>SEASON RECORD{team.remaining ? ` · ${team.remaining} TO PLAY` : ""}</span></div></div>
      <section className="listing" aria-labelledby="schedule-heading"><div className="section-title"><div><p className="kicker">GAME BY GAME</p><h2 id="schedule-heading">The schedule</h2></div><p>{schedule.length} games <span aria-hidden="true">↘</span></p></div>
        <div className="table-scroll"><table><thead><tr><th scope="col">Week</th><th scope="col">Date</th><th scope="col">Matchup</th><th scope="col">Score</th><th scope="col">Result</th></tr></thead><tbody>
          {schedule.map((game) => {
            const played = game.teamScore !== null && game.opponentScore !== null;
            const result = !played ? "Upcoming" : game.teamScore! > game.opponentScore! ? "W" : game.teamScore! < game.opponentScore! ? "L" : "T";
            return <tr key={game.gameId}><td className="muted">{game.week}</td><td className="date-cell">{formatGameDate(game.startDate)}</td><th scope="row"><span className="matchup-prefix">{game.home ? "vs" : "at"}</span> {game.opponentClass === "FBS" ? <Link className="primary-link" href={`/seasons/${year}/teams/${encodeURIComponent(game.opponentId)}`}>{game.opponentName} <span className="arrow" aria-hidden="true">↗</span></Link> : <span>{game.opponentName}</span>}{game.opponentClass && game.opponentClass !== "FBS" && <span className="subtext">{game.opponentClass}</span>}</th><td className="score-cell">{played ? `${game.teamScore} – ${game.opponentScore}${game.overtimes ? ` (${game.overtimes} OT)` : ""}` : "—"}</td><td><span className={`result result-${result.toLowerCase()}`}>{result}</span></td></tr>;
          })}
        </tbody></table>{schedule.length === 0 && <p className="empty">No games are scheduled for this team yet.</p>}</div>
      </section>
      <Link className="back-link" href={`/seasons/${year}`}>← Back to {year} standings</Link>
    </main>
  );
}

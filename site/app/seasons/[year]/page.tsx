import Link from "next/link";
import { connection } from "next/server";
import { notFound } from "next/navigation";
import { getStandings, hasSeason, parseYear } from "../../../lib/archive";

export default async function SeasonPage({ params }: PageProps<"/seasons/[year]">) {
  const { year: rawYear } = await params;
  const year = parseYear(rawYear);
  if (year === null) notFound();
  await connection();
  const standings = await getStandings(year);
  if (!standings.length && !(await hasSeason(year))) notFound();

  return (
    <main className="container content-page">
      <nav className="breadcrumbs" aria-label="Breadcrumb"><Link href="/">Seasons</Link><span aria-hidden="true">/</span><span aria-current="page">{year}</span></nav>
      <div className="page-heading"><div><p className="kicker">THE {year} SEASON</p><h1>{year} <em>standings.</em></h1><p className="intro">Every FBS team, ranked by its total regular-season record. Select a team to see its full schedule.</p></div><div className="heading-stat"><strong>{standings.length}</strong><span>FBS TEAMS</span></div></div>
      <section className="listing" aria-labelledby="standings-heading"><div className="section-title"><div><p className="kicker">THE FIELD</p><h2 id="standings-heading">Teams &amp; records</h2></div><p>W – L – T</p></div>
        <div className="table-scroll"><table><thead><tr><th scope="col">#</th><th scope="col">Team</th><th scope="col">Conference</th><th scope="col">W</th><th scope="col">L</th><th scope="col">T</th><th scope="col">To play</th></tr></thead><tbody>
          {standings.map((team, index) => <tr key={team.teamId}><td className="muted">{String(index + 1).padStart(2, "0")}</td><th scope="row"><Link className="primary-link" href={`/seasons/${year}/teams/${encodeURIComponent(team.teamId)}`}>{team.teamName} <span className="arrow" aria-hidden="true">↗</span></Link><span className="subtext">{team.abbreviation}</span></th><td className="muted">{team.conference}</td><td className="number-win">{team.wins}</td><td>{team.losses}</td><td>{team.ties}</td><td className="muted">{team.remaining}</td></tr>)}
        </tbody></table>{standings.length === 0 && <p className="empty">No FBS teams played this season.</p>}</div>
      </section>
    </main>
  );
}

import Link from "next/link";
import { connection } from "next/server";
import { getSeasons } from "../lib/archive";

async function SeasonsTable() {
  await connection();
  const seasons = await getSeasons();
  return (
    <div className="table-scroll">
      <table>
        <thead><tr><th scope="col">Season</th><th scope="col">FBS teams</th><th scope="col">Games played</th><th scope="col">Scheduled</th><th scope="col"><span className="sr-only">Explore</span></th></tr></thead>
        <tbody>
          {seasons.map((season) => (
            <tr key={season.year}>
              <th scope="row"><Link className="primary-link" href={`/seasons/${season.year}`}>{season.year} <span className="arrow" aria-hidden="true">↗</span></Link></th>
              <td>{season.fbsTeams}</td><td>{season.played.toLocaleString("en-US")}</td><td>{season.scheduled.toLocaleString("en-US")}</td>
              <td className="row-end">View standings <span aria-hidden="true">→</span></td>
            </tr>
          ))}
        </tbody>
      </table>
      {seasons.length === 0 && <p className="empty">No FBS seasons are available yet.</p>}
    </div>
  );
}

export default async function Home() {
  const table = await SeasonsTable();
  return (
    <main className="container">
      <div className="eyebrow"><span className="eyebrow-line" /> THE COLLEGE FOOTBALL ARCHIVE</div>
      <section className="hero">
        <div>
          <p className="kicker">A season-by-season record</p>
          <h1>Every season.<br /><em>Every Saturday.</em></h1>
          <p className="intro">Explore the teams, records, and regular-season scores that shaped college football. Pick a year to get started.</p>
        </div>
        <div className="hero-mark" aria-hidden="true"><span>CH</span><span>ARS</span><small>EST. 2001</small></div>
      </section>
      <section className="listing" aria-labelledby="seasons-heading">
        <div className="section-title"><div><p className="kicker">THE ARCHIVE</p><h2 id="seasons-heading">Seasons</h2></div><p>Browse by year <span aria-hidden="true">↘</span></p></div>
        {table}
      </section>
    </main>
  );
}

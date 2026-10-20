import Link from "next/link";
import { connection } from "next/server";
import { currentFootballSeason, defaultSnapshot, publishedSeason, START_SEASON, verifiedFinal } from "../lib/playoff";

export default async function Home() {
  await connection();
  const current = currentFootballSeason();
  const years = Array.from({ length: Math.max(0, current - START_SEASON + 1) }, (_, index) => current - index);
  const seasons = await Promise.all(years.map(async year => {
    const publication = await publishedSeason(year);
    const snapshot = defaultSnapshot(publication.snapshots);
    const state = !snapshot ? year === current ? "Preseason / awaiting data" : "Data incomplete" :
      snapshot.coverage.length ? "Data incomplete" : verifiedFinal(snapshot) ? "Final selection" :
        year === current ? "Current / provisional" : "Final selection unavailable";
    return { year, snapshot, state };
  }));
  return <main className="container">
    <div className="eyebrow"><span className="eyebrow-line" /> THE COLLEY PLAYOFF ARCHIVE</div>
    <section className="hero"><div><p className="kicker">A season-by-season selection</p><h1>Every season.<br /><em>Every contender.</em></h1>
      <p className="intro">Explore computed FBS Colley rankings and hypothetical playoff fields. Final brackets require a verified pre-championship selection snapshot; missing data is never filled in.</p></div>
      <div className="hero-mark" aria-hidden="true"><span>CH</span><span>ARS</span><small>EST. 2001</small></div></section>
    <section className="listing" aria-labelledby="seasons-heading"><div className="section-title"><div><p className="kicker">THE ARCHIVE</p><h2 id="seasons-heading">Seasons</h2></div><p>{START_SEASON}–{current}</p></div>
      <div className="table-scroll"><table><thead><tr><th scope="col">Season</th><th scope="col">Publication state</th><th scope="col">Snapshot</th></tr></thead><tbody>
        {seasons.map(({ year, snapshot, state }) => <tr key={year}><th scope="row"><Link className="primary-link" href={`/seasons/${year}`}>{year} <span className="arrow" aria-hidden="true">↗</span></Link></th><td>{state}</td><td>{snapshot ? snapshot.kind === "selection_final" ? "Pre-CCG final" : `Week ${snapshot.week ?? "partial"}` : "Not published"}</td></tr>)}
      </tbody></table></div></section>
  </main>;
}

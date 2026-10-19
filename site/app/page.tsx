import Link from "next/link";
import { getHomeData } from "@/lib/season-data";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export default function Home() {
  const { seasons, setup } = getHomeData();
  return (
    <main className="shell">
      <header className="masthead">
        <p className="eyebrow">College football · hypothetical playoff</p>
        <h1>CHARS</h1>
        <p>Season-by-season Colley ratings and selection. Results are calculated from stored regular-season games, not real-world playoff outcomes.</p>
      </header>
      {setup && <aside className="notice" role="status"><strong>Data setup</strong><p>{setup}</p></aside>}
      <section aria-labelledby="seasons-heading">
        <div className="section-head"><h2 id="seasons-heading">Seasons</h2><span>Newest first · 1998 onward</span></div>
        <ol className="season-grid">
          {seasons.map(season => (
            <li key={season.year}>
              <Link className="season-card" href={`/seasons/${season.year}`}>
                <span className="season-year">{season.year}</span>
                <span className={`badge ${season.state}`}>{season.state === "incomplete" ? "Data incomplete" : season.state}</span>
                <span className="season-detail">{season.detail}</span>
                <span aria-hidden="true" className="season-arrow">↗</span>
              </Link>
            </li>
          ))}
        </ol>
      </section>
    </main>
  );
}

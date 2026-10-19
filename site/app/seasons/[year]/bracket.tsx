import type { BracketView } from "@/lib/bracket-view";

export function Bracket({ bracket, stale }: { bracket: BracketView; stale: boolean }) {
  return <section className="bracket" aria-labelledby="bracket-heading">
    <h2 id="bracket-heading">Hypothetical playoff bracket</h2>
    {stale && <p className="notice" role="status"><strong>Retained stale bracket.</strong> This bracket belongs to the previously published final revision; underlying inputs may have changed. It is not a validated current result.</p>}
    <p className="subtle">Pre-CCG selection · fixed winner slots, no reseeding. Team A / Team B means either play-in team may advance; no results are predicted.</p>
    {bracket.slots.length === 0 ? <p>No eligible teams were selected; there is no bracket.</p> : <>
      <section aria-labelledby="playins-heading"><h3 id="playins-heading">Play-in round</h3>
        {bracket.playins.length === 0 && bracket.playinByes.length === 0 && <p>No play-in invitations.</p>}
        <ol className="bracket-list">{bracket.playins.map(pair => <li key={pair.id} className="match-card">
          <strong>Matchup {pair.id.replace("playin-", "")}</strong><span className="match-side"><span className="seed">Seed {pair.seed}</span>{pair.first}</span>
          <span className="match-side"><span className="seed">Seed {pair.seed}</span>{pair.second}</span><small>Winner takes main-bracket seed {pair.seed}</small>
        </li>)}{bracket.playinByes.map(bye => <li key={bye.seed} className="match-card"><strong>Play-in bye</strong>
          <span className="match-side"><span className="seed">Seed {bye.seed}</span>{bye.name}</span><small>Advances without a play-in game</small></li>)}</ol>
      </section>
      <section aria-labelledby="main-heading"><h3 id="main-heading">Main bracket</h3>
        {bracket.rounds.length === 0 && <p><span className="seed">Seed 1</span> {bracket.slots[0]?.label} is the only main-bracket slot; no matchup is played.</p>}
        <div className="bracket-rounds">{bracket.rounds.map(round => <section key={round.number} className="bracket-round" aria-label={round.label}>
          <h4>{round.label}</h4><ol className="bracket-list">{round.matches.map(match => <li key={match.id} className="match-card">
            <strong>{match.label}</strong>{match.sides.map((side, i) => side ? <span className="match-side" key={i}>
              {side.seed !== null && <span className="seed">Seed {side.seed}</span>}{side.label}</span> : null)}
            {match.bye && <small>Bye · advances without a game</small>}
          </li>)}</ol>
        </section>)}</div>
      </section>
      {bracket.champion && <p className="subtle">Championship outcome: {bracket.champion}. Hypothetical winners remain unknown.</p>}
    </>}
  </section>;
}

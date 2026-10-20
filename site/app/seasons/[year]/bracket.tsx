import type { SnapshotArtifact } from "../../../../packages/chars-db/src/snapshots";
import type { TeamIdentity } from "../../../lib/playoff";

export function Bracket({ playoff, identities }: { playoff: SnapshotArtifact["playoff"]; identities: Record<string, TeamIdentity> }) {
  const name = (id: string) => identities[id]?.teamName ?? id;
  const slots = new Map(playoff.mainSlots.map(slot => [slot.id, slot]));
  const matchLabel = new Map(playoff.rounds.flat().map(match => [match.id, `Winner of round ${match.round}, matchup ${match.position}`]));
  const entry = (source: { kind: "slot"; slotId: string } | { kind: "winner"; matchId: string }) => {
    if (source.kind === "winner") return matchLabel.get(source.matchId) ?? "Unresolved winner";
    const slot = slots.get(source.slotId);
    if (!slot) return "Unresolved slot";
    return `Seed ${slot.seed}: ${name(slot.teamAId)}${slot.teamBId ? ` / ${name(slot.teamBId)}` : ""}`;
  };
  return <section className="listing" aria-labelledby="bracket-heading"><div className="section-title"><div><p className="kicker">VERIFIED PRE-CCG SELECTION</p><h2 id="bracket-heading">Hypothetical bracket</h2></div><p>{playoff.counts.selected} selected · {playoff.counts.mainSlots} main slots</p></div>
    <p className="subtle">Play-in alternatives share a fixed seed. Winners are not predicted; no hypothetical matchup uses a real-world postseason result. Higher seeds receive main-bracket byes.</p>
    {playoff.shortFieldExplanation && <p className="notice">{playoff.shortFieldExplanation}</p>}
    <div className="bracket-rounds">
      <section aria-label="Play-in round" className="bracket-round"><h3>Play-in</h3>
        {playoff.playinByeTeamId && <div className="match-card"><strong>Play-in bye</strong><p>{name(playoff.playinByeTeamId)} advances to a main slot</p></div>}
        {playoff.playinPairs.map((pair, index) => <div className="match-card" key={pair.id} aria-label={`Play-in matchup ${index + 1}`}><strong>Matchup {index + 1}</strong><p>{name(pair.teamAId)} / {name(pair.teamBId)}</p><small>Winner enters seed {slots.get(pair.winnerSlotId)?.seed ?? "—"}</small></div>)}
        {!playoff.playinPairs.length && !playoff.playinByeTeamId && <p>No play-in matchups.</p>}
      </section>
      {playoff.rounds.map((round, index) => <section key={index} className="bracket-round" aria-label={`Main bracket round ${index + 1}`}><h3>Round {index + 1}</h3>
        {round.map(match => <div key={match.id} className="match-card" aria-label={`Round ${match.round}, matchup ${match.position}${match.isBye ? ", bye" : ""}`}><strong>Matchup {match.position}{match.isBye ? " · bye" : ""}</strong><p>{entry(match.first)}</p>{match.second && <p>vs {entry(match.second)}</p>}</div>)}
      </section>)}
      {!playoff.rounds.length && <p>{playoff.mainSlots.length === 1 ? `${entry({ kind: "slot", slotId: playoff.mainSlots[0]!.id })} · sole slot, no matchup` : "No bracket slots were selected."}</p>}
    </div>
  </section>;
}

import { STATUS_LABELS, statusHref, type StatusLabel, type TeamStatus, type WeeklyStatuses,
  type WitnessPath } from "@/lib/weekly-status";
import type { Ranking } from "@/lib/season-data";

const order = Object.keys(STATUS_LABELS) as StatusLabel[];

export function StatusBubbles({ base, week, search, view, active, statuses, rows }: {
  base: string; week: string; search: string; view: string; active: StatusLabel | null;
  statuses: WeeklyStatuses; rows: Ranking[];
}) {
  const counts = rows.reduce((acc, row) => {
    const team = statuses[row.teamId];
    if (team?.label) acc[team.label]++;
    return acc;
  }, { eliminated: 0, needs_help: 0, controls_destiny: 0, clinched: 0 });
  const unclassified = rows.length - Object.values(counts).reduce((sum, count) => sum + count, 0);
  return <section className="status-panel" aria-labelledby="weekly-status-title">
    <h2 id="weekly-status-title">End-of-season mathematical status</h2>
    <p>Qualification means a direct bid or play-in invitation at final selection, not a predicted playoff win. Provisional selections below are not proofs. Proofs assume a fixed remaining regular-season schedule and all eligible poll orders.</p>
    <p>Counts reflect the current team search and eligibility view, before the playoff-status filter.</p>
    <nav className="status-bubbles" aria-label="Filter rankings by playoff status">
      {order.map(label => <a key={label} className={`status-bubble ${label}${active === label ? " active" : ""}`}
        aria-label={`Show ${STATUS_LABELS[label]} teams (${counts[label]})`} aria-current={active === label ? "true" : undefined}
        href={statusHref(base, week, search, view, active === label ? null : label)}>
        <strong>{counts[label]}</strong><span>{STATUS_LABELS[label]}</span>
      </a>)}
    </nav>
    <p role="status">{unclassified} unclassified {unclassified === 1 ? "team" : "teams"} (pending, incomplete, or unsupported computation). These are not a fifth playoff status.</p>
    {active && <p>Filtering: {STATUS_LABELS[active]} · <a href={statusHref(base, week, search, view, null)}>Show all statuses</a></p>}
  </section>;
}

function outcomeText(id: string, outcome: WitnessPath["outcomes"][string], path: WitnessPath): string {
  const matchup = Object.hasOwn(path.matchups, id) ? path.matchups[id] : undefined;
  if (!matchup) return `Unknown game ${id}: ${outcome === "tie" ? "tie recorded" : `${outcome} outcome recorded`}; opponents unavailable`;
  return `${matchup.home} vs ${matchup.away} (${id}): ${outcome === "tie" ? "tie" :
    `${outcome === "home" ? matchup.home : matchup.away} wins`}`;
}

export function TeamStatusCell({ team, status, names }: { team: Ranking; status: TeamStatus | undefined; names: Map<string, string> }) {
  if (!status?.label) return <div><span className="badge pending" aria-label={`${team.name}: status unclassified, ${status?.state ?? "pending"}`}>
    Unclassified · {status?.state ?? "pending"}</span>
    {status?.state === "unsupported" && status.exception && <p className="exception">Policy/model exception: {status.exception}</p>}
  </div>;
  const title = STATUS_LABELS[status.label];
  return <div className="team-status"><span className={`badge status-${status.label}`} aria-label={`${team.name}: ${title}`}>
    {title}</span><details><summary>Why {title.toLowerCase()} for {team.name}?</summary>
    <p>{status.label === "clinched" ? "Qualifies in every permitted completion." :
      status.label === "eliminated" ? "No permitted completion qualifies." :
      status.label === "controls_destiny" ? "Winning out qualifies in every permitted completion." :
      "Winning out can qualify, but does not guarantee qualification."}</p>
    {status.pollDependent && <p><strong>Poll-dependent:</strong> voter choices can change qualification on a win-out path; winning alone is not a guarantee.</p>}
    {status.paths.map(path => <div key={path.kind} className="witness-path"><strong>One possible path — {path.kind.startsWith("qualifying") ? "qualifies" : "does not qualify"}; not a sufficient or necessary condition</strong>
      <p>{path.kind.endsWith("win_out") ? `${team.name} wins all remaining included games in this example.` : "Example of a permitted completion."}</p>
      <p>Example game outcomes: {Object.entries(path.outcomes).map(([id, outcome]) =>
        outcomeText(id, outcome, path)).join("; ") || "No remaining games"}.</p>
      <p>Assumed eligible poll order: {path.pollOrder.map(id => names.get(id) ?? id).join(" → ") || "empty"}.</p>
    </div>)}
    <p>Assumptions: {status.assumptions.join("; ")}.</p>
  </details></div>;
}

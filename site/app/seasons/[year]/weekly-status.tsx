import { STATUS_LABELS, statusHref, type StatusLabel, type TeamStatus, type WeeklyStatuses } from "@/lib/weekly-status";
import type { Ranking } from "@/lib/season-data";

const order = Object.keys(STATUS_LABELS) as StatusLabel[];

export function StatusBubbles({ base, week, search, view, active, statuses, total }: {
  base: string; week: string; search: string; view: string; active: StatusLabel | null;
  statuses: WeeklyStatuses; total: number;
}) {
  const counts = Object.values(statuses).reduce((acc, team) => {
    if (team.label) acc[team.label]++;
    return acc;
  }, { eliminated: 0, needs_help: 0, controls_destiny: 0, clinched: 0 });
  const unclassified = total - Object.values(counts).reduce((sum, count) => sum + count, 0);
  return <section className="status-panel" aria-labelledby="weekly-status-title">
    <h2 id="weekly-status-title">End-of-season mathematical status</h2>
    <p>Qualification means a direct bid or play-in invitation at final selection, not a predicted playoff win. Provisional selections below are not proofs. Proofs assume a fixed remaining regular-season schedule and all eligible poll orders.</p>
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

export function TeamStatusCell({ team, status, names }: { team: Ranking; status: TeamStatus | undefined; names: Map<string, string> }) {
  if (!status?.label) return <span className="badge pending" aria-label={`${team.name}: status unclassified, ${status?.state ?? "pending"}`}>
    Unclassified · {status?.state ?? "pending"}</span>;
  const title = STATUS_LABELS[status.label];
  const path = status.path;
  return <div className="team-status"><span className={`badge status-${status.label}`} aria-label={`${team.name}: ${title}`}>
    {title}</span><details><summary>Why {title.toLowerCase()}?</summary>
    <p>{status.label === "clinched" ? "Qualifies in every permitted completion." :
      status.label === "eliminated" ? "No permitted completion qualifies." :
      status.label === "controls_destiny" ? "Winning out qualifies in every permitted completion." :
      "Winning out can qualify, but does not guarantee qualification."}</p>
    {status.pollDependent && <p><strong>Poll-dependent:</strong> voter choices can change this path; winning alone is not a guarantee.</p>}
    {path && <div><strong>One possible path — not a sufficient or necessary condition</strong>
      <p>{path.winOut ? `${team.name} wins all remaining included games in this example.` : "Example of a permitted nonqualifying completion."}</p>
      <p>Example game outcomes: {Object.entries(path.outcomes).map(([id, outcome]) =>
        `${id}: ${outcome} wins`).join("; ") || "No remaining games"}.</p>
      <p>Assumed eligible poll order: {path.pollOrder.map(id => names.get(id) ?? id).join(" → ") || "empty"}.</p>
    </div>}
    <p>Assumptions: {status.assumptions.join("; ")}.</p>
  </details></div>;
}

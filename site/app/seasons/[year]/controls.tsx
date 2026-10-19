"use client";

import type { SnapshotOption } from "@/lib/season-data";

export function SnapshotControls({ base, options, selected, search, view }: {
  base: string; options: SnapshotOption[]; selected: string | undefined; search: string; view: string;
}) {
  const label = (option: SnapshotOption) => option.kind === "selection_final" ? "Final selection (pre-CCG)" :
    option.key.endsWith(":preseason") ? "Preseason" : `Week ${option.week}${option.kind === "partial" ? " · partial" : " · complete"}`;
  const index = options.findIndex(option => option.key === selected);
  const href = (key?: string) => {
    const params = new URLSearchParams();
    if (key) params.set("week", key);
    if (search) params.set("q", search);
    if (view === "eligible") params.set("view", view);
    return `${base}${params.size ? `?${params}` : ""}`;
  };
  return <div className="controls" aria-label="Snapshot navigation">
    <form action={base} method="get" className="controls-form">
      {search && <input type="hidden" name="q" value={search} />}
      {view === "eligible" && <input type="hidden" name="view" value={view} />}
      <label htmlFor="week">Snapshot</label><select id="week" name="week" defaultValue={selected ?? ""}>
        {!selected && <option value="" disabled>Choose a published snapshot</option>}
        {options.map(option => <option key={option.key} value={option.key}>{label(option)}{option.publicationState !== "current" ? ` · ${option.publicationState}` : ""}</option>)}
      </select><button type="submit">View snapshot</button>
    </form>
    <nav className="snapshot-nav" aria-label="Browse snapshots">
      {index >= 0 && options[index + 1] ? <a href={href(options[index + 1].key)}>← Older</a> : <span aria-disabled="true">← Older</span>}
      {index > 0 ? <a href={href(options[index - 1].key)}>Newer →</a> : <span aria-disabled="true">Newer →</span>}
      <a href={href()}>Latest / final</a>
    </nav>
  </div>;
}

export function RankingControls({ base, week, search, eligibleOnly }: {
  base: string; week?: string; search: string; eligibleOnly: boolean;
}) {
  return <div className="controls"><form action={base} method="get" role="search" className="controls-form">
    {week && <input type="hidden" name="week" value={week} />}
    <label htmlFor="team-search">Find a team</label><input id="team-search" type="search" name="q" defaultValue={search} placeholder="Team name or abbreviation" />
    <label htmlFor="view">Teams</label><select id="view" name="view" defaultValue={eligibleOnly ? "eligible" : "all"}>
      <option value="all">All FBS (including ineligible)</option><option value="eligible">Eligible only</option>
    </select><button type="submit">Apply</button>
  </form></div>;
}

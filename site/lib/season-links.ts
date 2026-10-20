export function seasonHref(year: number, week?: string): string {
  return `/seasons/${year}${week ? `?week=${encodeURIComponent(week)}` : ""}`;
}

export function teamHref(year: number, teamId: string, week?: string): string {
  return `/seasons/${year}/teams/${encodeURIComponent(teamId)}${week ? `?week=${encodeURIComponent(week)}` : ""}`;
}

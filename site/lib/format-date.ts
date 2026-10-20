const gameDateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "America/New_York",
});

export function formatGameDate(startDate: number): string {
  return gameDateFormatter.format(new Date(startDate));
}

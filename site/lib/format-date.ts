// Use the furthest-west domestic college-football timezone for a consistent schedule day.
// The database has no venue timezone, so this is an approximation for non-Hawai'i games.
const gameDateFormatter = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "Pacific/Honolulu",
});

export function formatGameDate(startDate: number): string {
  return gameDateFormatter.format(new Date(startDate));
}

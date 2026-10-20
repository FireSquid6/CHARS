"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";

export function WeekControls({ year, keys, selected, defaultKey }: { year: number; keys: { key: string; label: string }[]; selected: string; defaultKey: string }) {
  const router = useRouter();
  const index = keys.findIndex(entry => entry.key === selected);
  const url = (key: string) => `/seasons/${year}${key === defaultKey ? "" : `?week=${encodeURIComponent(key)}`}`;
  return <nav className="week-controls" aria-label="Snapshot navigation"><label htmlFor="snapshot-week">Snapshot</label>
    <select id="snapshot-week" value={selected} onChange={event => router.push(url(event.target.value))}>{keys.map(entry => <option key={entry.key} value={entry.key}>{entry.label}</option>)}</select>
    {index > 0 ? <Link href={url(keys[index - 1]!.key)}>← Previous week</Link> : <span>← Previous week</span>}
    {index < keys.length - 1 ? <Link href={url(keys[index + 1]!.key)}>Next week →</Link> : <span>Next week →</span>}
    <Link href={`/seasons/${year}`}>Return to latest / final</Link>
  </nav>;
}

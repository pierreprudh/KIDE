// Shared time formatting.
//
// This module used to carry a note saying elapsed-time helpers were being
// written per surface — "four separate `relativeTime` copies at last count" —
// and that "the old copies can migrate as their callers are touched". They
// didn't: all four were still there, byte-identical, and the module that named
// them had one real importer. A comment is not a seam.
//
// New time formatters go here, and there are no copies left to migrate.

/** A span of elapsed time, coarse on purpose: "18s", "4m", "1h 20m". For how
 *  long a conversation or run lasted, where minutes are the interesting unit —
 *  per-message precision belongs in the message footer. */
export function formatSpan(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m`;
  const hr = Math.floor(min / 60);
  const rest = min % 60;
  return rest ? `${hr}h ${rest}m` : `${hr}h`;
}

/** How long ago, coarse: "just now", "12m ago", "5h ago", "3d ago".
 *
 *  Takes `nowMs` so a caller can render a stable list, and so this is testable
 *  without freezing the clock. Anything older than a day stops counting hours —
 *  past that the exact figure stops being what the reader wants. */
export function relativeTime(ts: number, nowMs: number = Date.now()): string {
  const min = Math.floor((nowMs - ts) / 60_000);
  if (min < 1) return "just now";
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.floor(hr / 24)}d ago`;
}

/** How long ago, at finer resolution: adds seconds at the near end and months
 *  and years at the far end.
 *
 *  A second formatter rather than an option because the two answer different
 *  questions. `relativeTime` labels recent activity, where "just now" under a
 *  minute is what a reader wants; a Git history spans years, and "412d ago"
 *  is not a useful way to say "over a year". */
export function relativeTimeLong(ts: number, nowMs: number = Date.now()): string {
  const diff = Math.max(0, nowMs - ts);
  const s = Math.floor(diff / 1000);
  if (s < 5) return "just now";
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo ago`;
  return `${Math.floor(mo / 12)}y ago`;
}

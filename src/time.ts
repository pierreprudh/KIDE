// Shared time formatting. Elapsed-time helpers were being written per surface
// (four separate `relativeTime` copies at last count), which is why the same
// duration could read differently in the AI panel and on the run board. New
// formatters go here; the old copies can migrate as their callers are touched.

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

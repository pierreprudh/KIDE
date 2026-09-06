import { useEffect, useState } from "react";
import { DotGridLoader } from "./icons";

/* ─────────────────────────────────────────────────────────
 * WORKING ROW — the AI panel's "still alive" heartbeat.
 *
 * Shown while a run is in progress but nothing else animates
 * (no caret, no tool row). Three quiet parts on one line:
 *   • the orbit loader the rest of the panel already uses
 *   • a label with a shimmer sweeping through it
 *   • a live elapsed timer in mono tabular figures
 *
 * The timer is anchored to `since` — the turn's user message
 * timestamp — not to mount, so the row can come and go between
 * tool calls and the count keeps running from the real start.
 * Reduced motion freezes the shimmer; the timer still ticks.
 * ───────────────────────────────────────────────────────── */

function formatElapsed(ms: number): string {
  const total = Math.max(0, ms) / 1000;
  if (total < 60) return `${total.toFixed(1)}s`;
  return `${Math.floor(total / 60)}m ${(total % 60).toFixed(1)}s`;
}

/** Ticks ten times a second while mounted; `since` defaults to mount time. */
export function useElapsed(since?: number): string {
  const [start] = useState(() => since ?? Date.now());
  const anchor = since ?? start;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(t);
  }, []);
  return formatElapsed(now - anchor);
}

export function WorkingRow({
  label = "Working",
  since,
}: {
  label?: string;
  /** Epoch ms the turn started at. Absent → counts from mount. */
  since?: number;
}) {
  const elapsed = useElapsed(since);
  return (
    <div
      role="status"
      className="ai-msg-in"
      style={{ display: "flex", alignItems: "center", gap: 8, margin: "4px 0 6px 32px", color: "var(--fg-dim)" }}
    >
      <DotGridLoader size={11} label={label} />
      <span className="ai-working-label" style={{ fontSize: 12 }}>{label}</span>
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 11,
          color: "var(--fg-dim)",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {elapsed}
      </span>
    </div>
  );
}

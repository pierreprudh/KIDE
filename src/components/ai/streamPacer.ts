// The stream pacer — the reading cadence of a streamed answer.
//
// Deltas arrive in bursts: a fast model drops ten words in one network chunk,
// then nothing for a beat. Rendering them as they land makes the text lurch.
// The pacer holds the arrived-but-unshown text and releases it word by word
// on a steady tick, so the answer reads as being *said* rather than pasted —
// and each released word is exactly what `.ai-word-in` resolves in.
//
// It must never fall behind. The release size scales with the backlog: a
// fifth of the waiting words per tick, at least one, so a quick model drains
// in a few ticks and a slow one shows every word as it comes. Whatever is
// still waiting is drained whole the moment anything else has to render
// (a tool row, the final message, the run settling) — order on screen is
// always the order the model produced.
//
// Pure: a string in, a split out. The driver owns the timer.

export const PACE_TICK_MS = 35;

/** Words to release from this backlog on one tick. */
export function paceCount(pending: string): number {
  const words = pending.match(/\S+/g)?.length ?? 0;
  return Math.max(1, Math.ceil(words * 0.2));
}

/** Split `pending` into the text to show now and the text to keep waiting.
 *  Releases up to `count` complete words (each with the whitespace that
 *  follows it). A trailing partial word waits for its ending — unless it is
 *  all there is, in which case it goes out as-is and simply grows in place
 *  on the next tick (the view keys words by position, so a growing word is
 *  the same node, not a new one). */
export function takeWords(pending: string, count: number): [release: string, rest: string] {
  if (!pending) return ["", ""];
  const re = /\S+\s+/g;
  let end = 0;
  let taken = 0;
  let m: RegExpExecArray | null;
  const lead = /^\s*/.exec(pending)?.[0].length ?? 0;
  re.lastIndex = lead;
  while (taken < count && (m = re.exec(pending))) {
    end = m.index + m[0].length;
    taken += 1;
  }
  if (end === 0) return [pending, ""];
  return [pending.slice(0, end), pending.slice(end)];
}

// Ranking a file list against what the user typed. One implementation.
//
// There were two, with the same four tiers in opposite polarity: the command
// palette scored 100/80/70/50/20 and sorted descending, the AI panel's `@file`
// picker scored 0/1/2/3 and sorted ascending. So the same query over the same
// workspace produced a different order in the two pickers, and `isSubsequence`
// was written out twice, byte-identical, to serve both.
//
// The palette also had a tier the picker lacked — an exact basename match ranking
// above a prefix match — which is the more useful behaviour and is kept here.

/** Are `needle`'s characters all present in `hay`, in order? */
export function isSubsequence(needle: string, hay: string): boolean {
  let i = 0;
  for (let j = 0; j < hay.length && i < needle.length; j++) {
    if (hay[j] === needle[i]) i++;
  }
  return i === needle.length;
}

/** Last path segment, lower-cased with the input. */
function basename(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

/**
 * How well `path` matches `query`, lower is better; `null` means no match.
 *
 * The tiers, best first: the file is *named* what you typed, its name starts
 * with it, its full path starts with it, the path contains it, or the characters
 * appear in order somewhere.
 */
export function fileMatchRank(path: string, query: string): number | null {
  const q = query.trim().toLowerCase();
  if (!q) return 0;
  const lower = path.toLowerCase();
  const base = basename(lower);

  if (base === q) return 0;
  if (base.startsWith(q)) return 1;
  if (lower.startsWith(q)) return 2;
  if (lower.includes(q)) return 3;
  if (isSubsequence(q, lower)) return 4;
  return null;
}

/**
 * Rank `paths` against `query`, best first, capped at `limit`.
 *
 * Ties break on the shorter path, so `src/app.ts` beats
 * `src/features/app.ts` for "app" — the shallower file is nearly always the one
 * meant. An empty query returns the head of the list unranked, since the caller
 * has already ordered it (recents first, usually).
 */
export function rankFiles(paths: string[], query: string, limit = 8): string[] {
  if (!query.trim()) return paths.slice(0, limit);
  const scored: { path: string; rank: number }[] = [];
  for (const path of paths) {
    const rank = fileMatchRank(path, query);
    if (rank !== null) scored.push({ path, rank });
  }
  scored.sort((a, b) => a.rank - b.rank || a.path.length - b.path.length);
  return scored.slice(0, limit).map((s) => s.path);
}

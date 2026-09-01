// A changed file's git status → the one letter, colour and word Klide shows.
// One home, for every surface — in the same spirit as `runPresentation.ts`.
//
// This vocabulary used to exist twice: `gitLabel` + `gitDecorationForLabel` in
// `components/Sidebar.tsx` (the Explorer tree's decoration) and
// `statusLabel` + `statusColor` in `components/GitReview.tsx` (the changed-file
// list). The letter tables were a character-for-character copy, and the colour
// tables had already drifted: an untracked file was `--success` in the Explorer
// and `--accent` in Git Review. In the sage themes those two tokens hold the
// same value, so the split was invisible there and only showed up in a theme
// that separates them (the VS Code theme paints `--accent` blue) — the same
// file reading green in one surface and blue in the other.
//
// The Explorer's table won, because green-for-new matches every other editor:
//
//   M  Modified   --warning
//   A  Added      --success
//   U  Untracked  --success   (a new file, so the same colour as Added)
//   D  Deleted    --danger
//   R  Renamed    --accent    (no semantic token for "renamed"; the letter
//                              carries the meaning, the token keeps it
//                              theme-aware and distinct from D/M)

export type GitStatusMark = {
  /** The single letter a row shows in its status column. */
  label: string;
  /** A theme token, never a literal colour. */
  color: string;
  /** The word behind the letter — tooltips and screen readers. */
  title: string;
};

/**
 * The letter for a porcelain status code (`" M"`, `"??"`, `"MM"`, …), or null
 * when git reported something this vocabulary doesn't name.
 */
export function gitStatusLetter(status: string): string | null {
  if (status === "??") return "U";
  if (status.includes("M")) return "M";
  if (status.includes("A")) return "A";
  if (status.includes("D")) return "D";
  if (status.includes("R")) return "R";
  return null;
}

/**
 * The mark for a letter this vocabulary names, or null. Callers that already
 * hold a letter use this — the Explorer infers `"U"` for a file sitting under
 * an untracked folder, where git reports the folder, not the file.
 */
export function gitStatusMarkForLetter(label: string): GitStatusMark | null {
  if (label === "M") return { label, color: "var(--warning)", title: "Modified" };
  if (label === "A") return { label, color: "var(--success)", title: "Added" };
  if (label === "U") return { label, color: "var(--success)", title: "Untracked" };
  if (label === "D") return { label, color: "var(--danger)", title: "Deleted" };
  if (label === "R") return { label, color: "var(--accent)", title: "Renamed" };
  return null;
}

/** The mark for a porcelain status code, or null when there's nothing to show. */
export function gitStatusMark(status: string): GitStatusMark | null {
  const letter = gitStatusLetter(status);
  return letter ? gitStatusMarkForLetter(letter) : null;
}

/**
 * The placeholder a fixed-width status column falls back to, so a row keeps
 * its columns when git reports a code this vocabulary doesn't name. The
 * Explorer renders nothing instead; a list *of changes* still needs a glyph.
 */
export const UNNAMED_GIT_STATUS: GitStatusMark = {
  label: "-",
  color: "var(--fg-subtle)",
  title: "Changed",
};

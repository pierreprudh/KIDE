// One owner for how every xterm surface looks. Three terminals render PTYs
// (the drawer's TerminalPanel, the AI panel's DelegateTerminal, Mission
// Control's TaskTerminal) and they were each hand-rolling a 3-field theme —
// which meant the per-theme ANSI palette in theme.ts was never actually
// applied and program output fell back to xterm's default primaries.
import type { ITheme, ITerminalOptions } from "@xterm/xterm";
import { getTerminalAnsi, type ThemeId } from "./theme";

/** Monaspace Neon first, then the platform mono fallbacks. */
export const TERMINAL_FONT =
  "Monaspace Neon, Monaspace Argon, JetBrains Mono, SF Mono, Menlo, ui-monospace, monospace";

function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

/**
 * Surfaces nested deep in the AI panel don't get the theme threaded down to
 * them, and App.tsx already publishes it on `documentElement.data-theme` for
 * the CSS blocks in tokens.css. Read it from there rather than adding a prop
 * to every caller. `"dark"` is the legacy alias for Cursor Dark.
 */
export function activeThemeId(): ThemeId {
  const attr = document.documentElement.dataset.theme;
  if (!attr) return "klide-light";
  return (attr === "dark" ? "cursor-dark" : attr) as ThemeId;
}

/**
 * Full xterm palette for a Klide theme: chrome colors from tokens.css (so the
 * canvas and the panel around it can never drift) plus the 16 ANSI colors and
 * the selection wash from theme.ts.
 *
 * The background is always a real colour. xterm 6 keeps `allowTransparency` in
 * its options type but no longer implements it, so the old `#00000000` +
 * `allowTransparency` recipe doesn't produce a see-through canvas — it produces
 * an OPAQUE BLACK one, which on a light theme is near-black text on black. The
 * terminal is an opaque surface now; the drawer's ghosting is gone with it.
 */
export function terminalTheme(theme?: ThemeId | null): ITheme {
  const bg = cssVar("--terminal-bg");
  return {
    background: bg,
    foreground: cssVar("--terminal-fg"),
    cursor: cssVar("--terminal-cursor"),
    // Block cursor punches through to the surface color instead of black.
    cursorAccent: bg,
    ...getTerminalAnsi(theme ?? activeThemeId()),
  };
}

/**
 * Appearance options shared by all three surfaces. Callers still own behaviour
 * (scrollback, convertEol, disableStdin) and their own font size.
 */
export function terminalLook(theme?: ThemeId | null): ITerminalOptions {
  return {
    fontFamily: TERMINAL_FONT,
    theme: terminalTheme(theme),
    cursorStyle: "block",
    // Unfocused terminals show a hollow cursor — the calm way to answer
    // "which surface am I typing into?" without adding chrome.
    cursorInactiveStyle: "outline",
    // Bold text keeps its hue instead of jumping to the bright variant. The
    // palette is deliberately low-contrast; bold-is-bright undoes that.
    drawBoldTextInBrightColors: false,
  };
}

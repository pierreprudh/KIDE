import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";
import type { ThemeId } from "../theme";
import { terminalLook } from "../terminalTheme";
import { notify } from "../toast";
import {
  addTerminal,
  closeTerminal,
  ensureTerminal,
  getTerminals,
  renameTerminal,
  selectTerminal,
  subscribeTerminals,
  terminalExited,
  toggleSplitTerminal,
} from "../terminals";

type Props = {
  visible: boolean;
  onToggle: () => void;
  theme: ThemeId;
  height: number;
  workspaceRoot: string | null;
  fill?: boolean;
  /** The host insets this panel, so it reads as a floating card: all four
   *  corners round and the hairline closes all the way round. Full-bleed hosts
   *  leave it off — their bottom edge is the window's. */
  inset?: boolean;
  /** Move this terminal to Focus, where it docks under the canvas. Omitted
   *  where that would be circular — Focus's own dock — and on the
   *  grid/floating hosts, which are a different layout choice entirely. */
  onOpenInFocus?: () => void;
};

/** The panes' horizontal padding, and therefore the column every header zone
 *  aligns its text to. One constant because the alignment IS the relationship:
 *  change it in one place and the tabs drift off their terminals. */
const TERMINAL_INSET = 10;

const ICON = {
  width: 13,
  height: 13,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.5,
  strokeLinecap: "round",
  strokeLinejoin: "round",
} as const;

function ChevronDownIcon() {
  return (
    <svg {...ICON} width={14} height={14}>
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

/** Corners pushing outward — "take this to the bigger screen". */
function ExpandIcon() {
  return (
    <svg {...ICON}>
      <path d="M9 4H5a1 1 0 0 0-1 1v4M15 4h4a1 1 0 0 1 1 1v4M9 20H5a1 1 0 0 1-1-1v-4M15 20h4a1 1 0 0 0 1-1v-4" />
    </svg>
  );
}

/** Two panes side by side — the whole mark is the divider between them. */
function SplitIcon() {
  return (
    <svg {...ICON}>
      <rect x="4" y="5" width="16" height="14" rx="1.5" />
      <path d="M12 5v14" />
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg {...ICON}>
      <path d="M12 6v12M6 12h12" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg {...ICON} width={11} height={11} strokeWidth={1.6}>
      <path d="M6 6l12 12M18 6L6 18" />
    </svg>
  );
}

/** Quiet 24px icon button — the terminal header's only chrome recipe. */
function HeaderButton({
  onClick,
  label,
  title,
  rotated,
  children,
}: {
  onClick: () => void;
  label: string;
  title: string;
  rotated?: boolean;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={label}
      style={{
        width: 24,
        height: 24,
        border: "none",
        background: "transparent",
        cursor: "pointer",
        padding: 0,
        borderRadius: "var(--radius-sm)",
        display: "grid",
        placeItems: "center",
        color: "var(--terminal-muted)",
        transition:
          "background var(--motion-med) var(--ease-out), color var(--motion-med) var(--ease-out), transform var(--motion-med) var(--ease-soft)",
        transform: rotated ? "rotate(180deg)" : "none",
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.background = "var(--terminal-hover)";
        e.currentTarget.style.color = "var(--terminal-fg)";
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.background = "transparent";
        e.currentTarget.style.color = "var(--terminal-muted)";
      }}
    >
      {children}
    </button>
  );
}

/**
 * One tab. Active state is carried by type weight and colour only — no pill, no
 * underline, no dot. The close × is hover-revealed so a row of tabs reads as
 * words rather than as controls.
 */
function TerminalTabButton({
  label,
  active,
  onSelect,
  onClose,
}: {
  label: string;
  active: boolean;
  /** Absent for the split pane's own tab: it already sits over the pane it
   *  names, so there is nothing for a click to select. It renders as a plain
   *  label then, rather than advertising an action it doesn't have. */
  onSelect?: () => void;
  onClose: () => void;
}) {
  const [hovered, setHovered] = useState(false);
  const labelStyle = {
    border: "none",
    background: "transparent",
    font: "inherit",
    fontSize: 11.5,
    letterSpacing: "-0.01em",
    fontWeight: active ? 550 : 400,
    color: active ? "var(--terminal-fg)" : "var(--terminal-muted)",
    padding: "3px 2px 3px 0",
    transition: "color var(--motion-med) var(--ease-out)",
  } as const;
  return (
    <span
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{ display: "inline-flex", alignItems: "center", gap: 1, flexShrink: 0, minWidth: 0 }}
    >
      {onSelect ? (
        <button
          type="button"
          role="tab"
          aria-selected={active}
          onClick={onSelect}
          style={{ ...labelStyle, cursor: "pointer" }}
        >
          {label}
        </button>
      ) : (
        <span
          style={{
            ...labelStyle,
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {label}
        </span>
      )}
      <button
        type="button"
        onClick={onClose}
        title={`Close ${label}`}
        aria-label={`Close ${label}`}
        style={{
          width: 16,
          height: 16,
          marginRight: 8,
          border: "none",
          background: "transparent",
          padding: 0,
          borderRadius: "var(--radius-sm)",
          display: "grid",
          placeItems: "center",
          cursor: "pointer",
          color: "var(--terminal-muted)",
          // Reserved space, revealed on hover — the row never reflows.
          opacity: hovered ? 1 : 0,
          pointerEvents: hovered ? "auto" : "none",
          transition: "opacity var(--motion-med) var(--ease-out)",
        }}
      >
        <CloseIcon />
      </button>
    </span>
  );
}

/**
 * One xterm bound to one Rust shell. The shell outlives this component: mount
 * attaches (`pty_spawn` is idempotent per id), unmount only detaches.
 */
function TerminalPane({
  sessionId,
  theme,
  workspaceRoot,
  dimmed,
  onFocusPane,
}: {
  sessionId: string;
  theme: ThemeId;
  workspaceRoot: string | null;
  dimmed: boolean;
  onFocusPane: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const claimSize = useRef<() => void>(() => {});

  useEffect(() => {
    if (!ref.current) return;
    const term = new Terminal({
      // A little more air than 12/1.3 — output reads as prose, not as a
      // packed log. The full palette + cursor recipe lives in terminalTheme.
      fontSize: 12.5,
      lineHeight: 1.4,
      ...terminalLook(theme),
      cursorBlink: true,
      scrollback: 5000,
      allowProposedApi: true,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(ref.current);

    let disposed = false;
    let frame = 0;
    let sent = { rows: 0, cols: 0 };
    // The shell reads its window size from the PTY, so xterm fitting itself is
    // only half the job — without this the shell keeps wrapping at its
    // spawn-time width and long output looks broken. Per session, so a split's
    // two panes don't fight over one geometry.
    //
    // Three guards, all of which a split makes necessary: fitting resizes the
    // element we're observing, so an unguarded ResizeObserver callback can feed
    // itself; the PTY only needs telling when the grid actually changed, not on
    // every frame of a layout settling; and fit() throws on a detached or
    // zero-sized element, which is exactly what a pane closing looks like.
    const syncSize = () => {
      if (disposed) return;
      try {
        fit.fit();
      } catch {
        return;
      }
      if (term.rows <= 0 || term.cols <= 0) return;
      if (term.rows === sent.rows && term.cols === sent.cols) return;
      sent = { rows: term.rows, cols: term.cols };
      void invoke("pty_resize", { id: sessionId, rows: term.rows, cols: term.cols }).catch(
        () => {}
      );
    };
    // One fit per frame, no matter how many resize notifications arrive.
    const scheduleSync = () => {
      if (disposed || frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        syncSize();
      });
    };
    claimSize.current = scheduleSync;
    syncSize();

    const spawn = () => {
      invoke("pty_spawn", {
        id: sessionId,
        workspaceRoot,
        rows: term.rows,
        cols: term.cols,
      }).catch((e) => {
        if (disposed) return;
        const msg = e instanceof Error ? e.message : String(e);
        // Surface inline in the panel itself (red), not just a toast — a blank
        // terminal that silently failed to start reads as a frozen app.
        term.writeln(`\x1b[31mShell failed to start: ${msg}\x1b[0m`);
        notify(`Terminal failed to start: ${msg}`, {
          tone: "error",
          action: { label: "Retry", run: spawn },
        });
      });
    };
    spawn();

    const unlistenData = listen<{ id: string; chunk: string }>("pty:data", (e) => {
      // Unlistening is async, so a chunk can still arrive after this pane is
      // gone — writing to a disposed Terminal throws, which took the whole view
      // down when a split closed mid-output.
      if (disposed || e.payload.id !== sessionId) return;
      term.write(e.payload.chunk);
    });
    const unlistenExit = listen<string>("pty:exit", (e) => {
      if (e.payload !== sessionId) return;
      terminalExited(sessionId);
    });
    term.onData((data) => {
      if (disposed) return;
      void invoke("pty_write", { id: sessionId, data }).catch(() => {});
    });

    const resize = new ResizeObserver(scheduleSync);
    resize.observe(ref.current);

    return () => {
      disposed = true;
      if (frame) cancelAnimationFrame(frame);
      claimSize.current = () => {};
      unlistenData.then((u) => u());
      unlistenExit.then((u) => u());
      resize.disconnect();
      term.dispose();
    };
  }, [sessionId, theme, workspaceRoot]);

  return (
    <div
      ref={ref}
      className="klide-term"
      onFocus={() => {
        onFocusPane();
        // Whoever is being typed into owns its shell's geometry.
        claimSize.current();
      }}
      style={{
        flex: 1,
        minWidth: 0,
        minHeight: 0,
        // Tight: the shell's own left margin is already whitespace, so a wide
        // gutter on top of it just wastes rows and columns. No top-fade mask
        // either — it cost a compositing layer per pane for a 12px flourish.
        padding: `4px ${TERMINAL_INSET}px 6px`,
        // Ghostty's unfocused-split dim, dialled way down: enough to tell you
        // where the keyboard is, not enough to read as disabled.
        opacity: dimmed ? 0.94 : 1,
        transition: "opacity var(--motion-med) var(--ease-out)",
      }}
    />
  );
}

export function TerminalPanel({
  visible,
  onToggle,
  theme,
  height,
  workspaceRoot,
  fill,
  inset,
  onOpenInFocus,
}: Props) {
  const [focused, setFocused] = useState(false);
  const terminals = useSyncExternalStore(subscribeTerminals, getTerminals);
  // Which pane the keyboard is in — only meaningful while split.
  const [focusedPane, setFocusedPane] = useState<"primary" | "split">("primary");

  // Opening the terminal shouldn't need a separate "create a shell" step.
  useEffect(() => {
    if (visible) ensureTerminal();
  }, [visible]);

  // Tab titles follow whatever each shell is running. One listener for the
  // panel, not one per pane: a background tab's title has to keep up too, and
  // the event carries the session id.
  useEffect(() => {
    const unlisten = listen<{ id: string; title: string }>("pty:title", (e) => {
      renameTerminal(e.payload.id, e.payload.title);
    });
    return () => {
      unlisten.then((u) => u());
    };
  }, []);

  // Closing the last tab closes the terminal — an open surface with no shell in
  // it is a dead end. Gated on having had one, or the first mount (tabs are
  // still empty until the effect above runs) would slam it shut immediately.
  const hadTabs = useRef(false);
  useEffect(() => {
    if (terminals.tabs.length > 0) {
      hadTabs.current = true;
      return;
    }
    if (visible && hadTabs.current) onToggle();
  }, [terminals.tabs.length, visible, onToggle]);

  const activeId = terminals.activeId;
  const splitId = terminals.splitId;
  const split = splitId !== null;
  const splitTab = splitId ? terminals.tabs.find((tab) => tab.id === splitId) ?? null : null;
  // The split's tab moves out of the strip and over its own pane, so the strip
  // is left with the tabs the primary pane can actually show.
  const primaryTabs = terminals.tabs.filter((tab) => tab.id !== splitId);
  // 24px buttons with 2px gaps: split + collapse, plus expand where it exists.
  const actionsWidth = (onOpenInFocus ? 3 : 2) * 24 + (onOpenInFocus ? 2 : 1) * 2 + 6;

  return (
    <div
      // In fill mode (the bottom drawer) the shell already animates the
      // entrance — a second content animation reads as double motion.
      className={!fill && visible ? "terminal-enter" : undefined}
      aria-hidden={!visible}
      onFocus={() => setFocused(true)}
      onBlur={() => setFocused(false)}
      style={{
        height: fill ? "100%" : visible ? height : 0,
        flex: fill ? 1 : undefined,
        flexShrink: 0,
        overflow: "hidden",
        opacity: fill || visible ? 1 : 0,
        // Opaque, and the same colour as the canvas. The old translucent wash
        // relied on xterm drawing a see-through canvas over it, which xterm 6
        // no longer does (see terminalTheme) — a wash over an opaque canvas is
        // just a mismatched strip above the output. No backdrop blur ever
        // either: off-brand, and the webview bug that hides floating panels.
        background: "var(--terminal-bg)",
        // Rounded all the way round when the host insets it; otherwise only the
        // two corners not sitting on the window's own edge. Note the corners are
        // drawn where no xterm canvas reaches (the header, and the panes'
        // padding) — a composited canvas can ignore an ancestor's radius clip
        // in this webview, so the shape is kept clear of it rather than relying
        // on `overflow: hidden` to cut it.
        borderRadius: inset
          ? "var(--radius-lg)"
          : "var(--radius-lg) var(--radius-lg) 0 0",
        // A hairline on the three exposed sides. The sides are what make the
        // rounded corners legible: the terminal surface sits ~4/255 per channel
        // off the canvas behind it, so the corner shape alone has nothing to
        // read against — the line is the edge, the radius just bends it.
        //
        // The top of that line also carries focus: it warms to the accent while
        // you're typing here and settles back when focus leaves. One 1px
        // signal, no ring, no badge.
        borderTop: visible
          ? `1px solid ${
              focused
                ? "color-mix(in srgb, var(--accent) 55%, var(--terminal-border))"
                : "var(--terminal-border)"
            }`
          : "1px solid transparent",
        borderLeft: visible ? "1px solid var(--terminal-border)" : "1px solid transparent",
        borderRight: visible ? "1px solid var(--terminal-border)" : "1px solid transparent",
        borderBottom:
          inset && visible ? "1px solid var(--terminal-border)" : "1px solid transparent",
        transition:
          "height 240ms var(--ease-soft), opacity 180ms var(--ease-out), border-color 180ms var(--ease-out), background 180ms var(--ease-out)",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* Header — the tabs ARE the title now, so there's no "Terminal" label
          and no inset highlight to lift a strip that no longer needs lifting.
          What's left is words, four quiet glyphs, and one fading hairline.

          Split, the header splits with it. The geometry is shared with the
          panes rather than approximated: no padding on this row, zones that are
          `flex: 1`, and a bare 1px divider — the same three rules the pane row
          below uses, so the two dividers land on the exact same pixel. Each
          zone then carries TERMINAL_INSET, which is the panes' own horizontal
          padding, so a tab's text starts on the same column as the glyphs
          underneath it. */}
      <div
        style={{
          position: "relative",
          display: "flex",
          alignItems: "stretch",
          height: 26,
          flexShrink: 0,
        }}
      >
        <div
          role="tablist"
          aria-label="Terminal sessions"
          style={{
            display: "flex",
            alignItems: "center",
            flex: 1,
            minWidth: 0,
            overflowX: "auto",
            scrollbarWidth: "none",
            paddingLeft: TERMINAL_INSET,
            // Only the last zone reserves room for the pinned actions.
            paddingRight: split ? 0 : actionsWidth,
          }}
        >
          {primaryTabs.map((tab) => (
            <TerminalTabButton
              key={tab.id}
              label={tab.title}
              active={tab.id === activeId}
              onSelect={() => selectTerminal(tab.id)}
              onClose={() => closeTerminal(tab.id)}
            />
          ))}
          <HeaderButton onClick={() => addTerminal()} label="New terminal" title="New terminal">
            <PlusIcon />
          </HeaderButton>
        </div>
        {splitTab && (
          <>
            {/* Continues the panes' divider up through the header — one line,
                not two, so the split reads as two columns rather than a strip
                sitting on top of them. */}
            <div
              aria-hidden
              style={{
                width: 1,
                flexShrink: 0,
                background:
                  "linear-gradient(to bottom, transparent 0%, var(--terminal-border) 45%, var(--terminal-border) 100%)",
              }}
            />
            <div
              style={{
                display: "flex",
                alignItems: "center",
                flex: 1,
                minWidth: 0,
                paddingLeft: TERMINAL_INSET,
                // Keeps a long process name from running under the actions.
                paddingRight: actionsWidth,
              }}
            >
              <TerminalTabButton
                label={splitTab.title}
                active
                onClose={() => closeTerminal(splitTab.id)}
              />
            </div>
          </>
        )}
        {/* Panel-level actions, pinned to the edge rather than laid out as a
            third column — as a flex sibling they'd steal width from the right
            zone and drag the header's divider out of line with the panes'. */}
        <div
          style={{
            position: "absolute",
            top: 0,
            bottom: 0,
            right: 4,
            display: "flex",
            alignItems: "center",
            gap: 2,
          }}
        >
          <HeaderButton
            onClick={() => toggleSplitTerminal()}
            label={split ? "Close the split" : "Split the terminal"}
            title={split ? "Close the split" : "Split — a second shell beside this one"}
          >
            <SplitIcon />
          </HeaderButton>
          {onOpenInFocus && (
            <HeaderButton
              onClick={onOpenInFocus}
              label="Open in Focus"
              title="Open in Focus — the shells keep running"
            >
              <ExpandIcon />
            </HeaderButton>
          )}
          <HeaderButton
            onClick={onToggle}
            label={visible ? "Hide terminal" : "Show terminal"}
            title={visible ? "Hide terminal" : "Show terminal"}
            rotated={!visible}
          >
            <ChevronDownIcon />
          </HeaderButton>
        </div>
        {visible && (
          <div
            aria-hidden
            style={{
              position: "absolute",
              left: TERMINAL_INSET,
              right: TERMINAL_INSET,
              bottom: 0,
              height: 1,
              background:
                "linear-gradient(to right, transparent 0%, var(--terminal-border) 18%, var(--terminal-border) 82%, transparent 100%)",
              pointerEvents: "none",
            }}
          />
        )}
      </div>
      {visible && (
        <div style={{ flex: 1, minHeight: 0, display: "flex" }}>
          {activeId && (
            <TerminalPane
              key={activeId}
              sessionId={activeId}
              theme={theme}
              workspaceRoot={workspaceRoot}
              dimmed={split && focusedPane !== "primary"}
              onFocusPane={() => setFocusedPane("primary")}
            />
          )}
          {splitId && (
            <>
              {/* The only divider in the panel: one hairline, no gutter. */}
              <div
                aria-hidden
                style={{
                  width: 1,
                  flexShrink: 0,
                  // Fades out at both ends rather than running corner to
                  // corner — the same softening the header hairline uses, and
                  // it keeps the rule off the rounded bottom corners.
                  background:
                    "linear-gradient(to bottom, var(--terminal-border) 0%, var(--terminal-border) 78%, transparent 100%)",
                }}
              />
              <TerminalPane
                key={splitId}
                sessionId={splitId}
                theme={theme}
                workspaceRoot={workspaceRoot}
                dimmed={focusedPane !== "split"}
                onFocusPane={() => setFocusedPane("split")}
              />
            </>
          )}
        </div>
      )}
    </div>
  );
}

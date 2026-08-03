import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import { createPortal } from "react-dom";
import type { GlyphProps } from "../icons";
import {
  AiIcon,
  ChevronIcon,
  FocusLayoutIcon,
  FolderIcon,
  GitIcon,
  HomeIcon,
  MemoryIcon,
  MissionIcon,
  OrchestratorIcon,
  SearchIcon,
  SkillsIcon,
} from "../icons";
import { useFlipIndicator } from "../hooks/useFlipIndicator";
import { KbdFor } from "./Kbd";
import { Z } from "../zLayers";
import { RAIL_DESTINATIONS, railDestination } from "../railDestinations";
import { useUserInfo, initialsOf } from "../hooks/useUserInfo";

type View = "home" | "explorer" | "git" | "memory" | "skills" | "ai" | "runs" | "orchestrator" | "settings" | "profile";

/** A submenu beside (collapsed: hover flyout) or under (expanded: inline
 *  list) a rail item — quiet rows in the same soft-fill language as the
 *  tabs. Only items with real sub-destinations declare one. */
export type RailSubmenu = {
  title: string;
  items: { key: string; label: string; active?: boolean; onSelect: () => void }[];
};

type Props = {
  active: Record<View, boolean>;
  onToggle: (v: View, meta?: boolean) => void;
  /** Opens the command palette — rendered as the rail's search entry. */
  onSearch?: () => void;
  /** Expanded-mode label for the top Home entry — the current project's
   *  name, making Home the project-level item (its submenu switches
   *  projects; the Explorer below it is purely the file tree). */
  homeLabel?: string;
  submenus?: Partial<Record<View, RailSubmenu>>;
  /** Switches the shell into Focus. Sits beside the identity card, the same
   *  slot the Focus rail puts its way back out — one place, either direction. */
  onEnterFocus?: () => void;
};

/* Glyphs come from ../icons — the one place the app decides what a thing
   looks like. This rail only decides how big to draw it. */

function ChevronSmall({ open }: { open: boolean }) {
  return <ChevronIcon size={12} open={open} />;
}

/* Settings + Profile icons live in ../railDestinations — shared with the
   Focus rail's foot so both sidebars draw the same destinations. */


/** Expanded rail width — icons + labels, per the reference. */
const RAIL_EXPANDED_W = 216;

export function ActivityBar({
  active,
  onToggle,
  onSearch,
  homeLabel,
  submenus,
  onEnterFocus,
}: Props) {
  const { username, hostname, avatarUrl } = useUserInfo();
  // Expanded ↔ collapsed (the reference's two states). Collapsed is the icon
  // rail; expanded shows icon + label rows, the search entry, and inline
  // submenus. Persisted per machine.
  const [expanded, setExpandedState] = useState(
    () => localStorage.getItem("klide-rail-expanded") === "true"
  );
  function toggleExpanded() {
    setExpandedState((cur) => {
      localStorage.setItem("klide-rail-expanded", String(!cur));
      // Collapsing folds any open inline submenu — rows must land exactly on
      // the collapsed grid, and the flyout takes over submenu duty.
      if (cur) setOpenInline(new Set());
      return !cur;
    });
    setMenu(null);
  }

  // Which items' inline submenus are unfolded (expanded mode only).
  const [openInline, setOpenInline] = useState<ReadonlySet<View>>(new Set());
  function toggleInline(view: View) {
    setOpenInline((cur) => {
      const next = new Set(cur);
      if (next.has(view)) next.delete(view);
      else next.add(view);
      return next;
    });
  }

  // Hover-intent flyout (collapsed mode only): opens after a beat on an item
  // that declares a submenu, survives the pointer travelling into the card,
  // closes shortly after leaving both. Clicking the item itself still
  // toggles the view.
  const [menu, setMenu] = useState<{ view: View; top: number; left: number } | null>(null);
  const openTimer = useRef<number | null>(null);
  const closeTimer = useRef<number | null>(null);
  useEffect(
    () => () => {
      if (openTimer.current !== null) window.clearTimeout(openTimer.current);
      if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    },
    []
  );

  function scheduleOpen(view: View, e: ReactMouseEvent<HTMLButtonElement>) {
    if (expanded) return;
    const submenu = submenus?.[view];
    if (!submenu || submenu.items.length === 0) return;
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    if (openTimer.current !== null) window.clearTimeout(openTimer.current);
    const rect = e.currentTarget.getBoundingClientRect();
    openTimer.current = window.setTimeout(() => {
      setMenu({ view, top: rect.top - 6, left: rect.right + 10 });
    }, 260);
  }

  function scheduleClose() {
    if (openTimer.current !== null) window.clearTimeout(openTimer.current);
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
    closeTimer.current = window.setTimeout(() => setMenu(null), 220);
  }

  function cancelClose() {
    if (closeTimer.current !== null) window.clearTimeout(closeTimer.current);
  }

  const openSubmenu = menu ? submenus?.[menu.view] : undefined;

  // Top zone — in-workbench / full-window tools. The FLIP fill rides
  // between them when one is active.
  const toolItems: { id: View; label: string; Icon: (p: GlyphProps) => React.JSX.Element }[] = [
    { id: "explorer", label: "Explorer", Icon: FolderIcon },
    { id: "git", label: "Git", Icon: GitIcon },
    { id: "memory", label: "Memory", Icon: MemoryIcon },
    { id: "skills", label: "Skills", Icon: SkillsIcon },
    { id: "ai", label: "AI", Icon: AiIcon },
    { id: "runs", label: "Mission Control", Icon: MissionIcon },
    { id: "orchestrator", label: "Orchestrator", Icon: OrchestratorIcon },
  ];

  // Bottom zone — app-level destinations, defined once in railDestinations so
  // the Focus rail's foot renders the same set. Active state is the dock dot,
  // so it can never be confused with the top zone's sliding fill.
  //
  // Profile is pulled out of the loop: like the Focus rail, it renders as the
  // identity card (avatar + name + host) rather than a plain labeled row,
  // because it has something to show that a label can't.
  const destinationItems = RAIL_DESTINATIONS.filter((d) => d.id !== "profile");
  const profileDest = railDestination("profile");

  const activeTool = toolItems.reduce<View | null>(
    (acc, n) => (active[n.id] ? n.id : acc),
    null,
  );
  const flip = useFlipIndicator(activeTool, {
    size: 40,
    active: activeTool !== null,
    // Rows move without the active tool changing when the rail switches
    // density or an inline submenu unfolds above the active item — both
    // must trigger a re-measure or the highlight drifts.
    remeasureKey: `${expanded}:${[...openInline].sort().join(",")}`,
  });

  // ONE row geometry for both modes — this is what makes the collapse read
  // as a single motion. Icons sit at the same x in both states (margin 8 +
  // padding 11); collapsed just means the rail is 56px so the row is a
  // 40px-wide strip and the label clips away under overflow:hidden while it
  // fades. Nothing ever jumps — only the width animates and the text
  // dissolves.
  function rowStyle(isActive: boolean): React.CSSProperties {
    return {
      position: "relative",
      zIndex: 1,
      display: "flex",
      alignItems: "center",
      gap: 10,
      // NOTE: height + radius are mirrored by .klide-activity-bar-indicator
      // in tokens.css — the FLIP fill must hug the row exactly.
      height: 36,
      margin: "0 8px",
      padding: "0 11px",
      borderRadius: 8,
      textAlign: "left",
      overflow: "hidden",
      whiteSpace: "nowrap",
      color: isActive ? "var(--fg-strong)" : "var(--fg-subtle)",
    };
  }

  const rowLabel: React.CSSProperties = {
    flex: 1,
    minWidth: 0,
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
    fontSize: 12.5,
    opacity: expanded ? 1 : 0,
    transition: "opacity 180ms var(--ease-out)",
  };

  return (
    <nav
      aria-label="Activity"
      className="klide-rail"
      // The rail reaches the window's top edge and the traffic lights sit on
      // it, so its blank areas move the window like a native sidebar. Items
      // are their own event targets and still click through.
      data-tauri-drag-region
      style={{
        width: expanded ? RAIL_EXPANDED_W : "var(--size-activity-bar)",
        flexShrink: 0,
        transition: "width 240ms var(--ease-soft)",
        background: "var(--bg-elevated)",
        borderRight: "1px solid var(--border)",
        display: "flex",
        flexDirection: "column",
        alignItems: "stretch",
        position: "relative",
        // Above the docks (Z.dock): the expand pebble straddles the rail's
        // right edge, exactly where the explorer drawer slides in.
        zIndex: Z.rail,
      }}
    >
      {/* Edge toggle — the reference's chevron pebble straddling the rail
          edge; hover the rail to reveal it. */}
      <button
        type="button"
        className="klide-rail-toggle"
        onClick={toggleExpanded}
        title={expanded ? "Collapse sidebar" : "Expand sidebar"}
        aria-label={expanded ? "Collapse sidebar" : "Expand sidebar"}
        aria-expanded={expanded}
      >
        <svg
          width="11"
          height="11"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
          style={{
            transform: expanded ? "rotate(180deg)" : "none",
            transition: "transform var(--motion-med) var(--ease-soft)",
          }}
        >
          <path d="m9 6 6 6-6 6" />
        </svg>
      </button>

      {/* Top zone — starts below the traffic lights, which float over the
          rail now that the native title bar is hidden. It fills the rail, so
          it (not the <nav>) is what the pointer hits in the blank space, and
          it carries the drag region. */}
      <div
        data-tauri-drag-region
        style={{
          flex: 1,
          minHeight: 0,
          padding: "calc(10px + var(--titlebar-h)) 0 10px",
          display: "flex",
          flexDirection: "column",
          alignItems: "stretch",
          overflowY: "auto",
          overflowX: "hidden",
        }}
      >
        {/* Home — the project-level entry: click returns to the workbench,
            its submenu switches projects (recent folders; the native macOS
            Projects menu remains the full switcher). Expanded shows the
            current project's name. The Explorer below is purely files. */}
        <button
          onClick={() => {
            setMenu(null);
            onToggle("home");
          }}
          title={homeLabel ? `${homeLabel} — back to workbench` : "Back to workbench"}
          aria-label="Back to workbench"
          aria-haspopup={submenus?.home && submenus.home.items.length > 0 ? "menu" : undefined}
          className="klide-activity-bar-item"
          style={rowStyle(false)}
          onMouseEnter={(e) => {
            e.currentTarget.style.color = "var(--fg-strong)";
            scheduleOpen("home", e);
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.color = "var(--fg-subtle)";
            scheduleClose();
          }}
        >
          <span style={{ flexShrink: 0, display: "inline-flex" }}><HomeIcon /></span>
          <span style={{ ...rowLabel, fontWeight: 500 }}>{homeLabel ?? "Home"}</span>
          {expanded && submenus?.home && submenus.home.items.length > 0 && (
            <span
              role="button"
              tabIndex={0}
              aria-label={`${openInline.has("home") ? "Collapse" : "Expand"} project submenu`}
              onClick={(e) => {
                e.stopPropagation();
                toggleInline("home");
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  e.stopPropagation();
                  toggleInline("home");
                }
              }}
              style={{
                display: "grid",
                placeItems: "center",
                width: 20,
                height: 20,
                borderRadius: 6,
                color: "var(--fg-dim)",
                flexShrink: 0,
              }}
            >
              <ChevronSmall open={openInline.has("home")} />
            </span>
          )}
        </button>
        {expanded && openInline.has("home") && submenus?.home && submenus.home.items.length > 0 && (
          <div style={{ position: "relative", margin: "2px 8px 2px 8px", paddingLeft: 30 }}>
            <span
              aria-hidden
              style={{
                position: "absolute",
                left: 20,
                top: 0,
                bottom: 8,
                width: 1,
                background: "var(--border)",
              }}
            />
            {submenus.home.items.map((item) => (
              <button
                key={item.key}
                type="button"
                className="klide-rail-flyout-row"
                data-active={item.active ? "true" : undefined}
                style={{ width: "100%" }}
                onClick={() => item.onSelect()}
              >
                {item.label}
              </button>
            ))}
          </div>
        )}

        {/* Search — the command palette as the rail's search entry. */}
        {onSearch && (
          <button
            type="button"
            onClick={() => {
              setMenu(null);
              onSearch();
            }}
            title="Go to file"
            aria-label="Go to file"
            className="klide-activity-bar-item"
            style={{
              ...rowStyle(false),
              marginTop: 8,
              marginBottom: 2,
              border: "1px solid var(--border)",
            }}
          >
            <span style={{ flexShrink: 0, display: "inline-flex" }}><SearchIcon size={17} /></span>
            <span
              style={{
                ...rowLabel,
                display: "inline-flex",
                alignItems: "center",
                gap: 8,
              }}
            >
              <span style={{ flex: 1, textAlign: "left", color: "var(--fg-dim)" }}>Search</span>
              <KbdFor id="go-to-file" />
            </span>
          </button>
        )}

        {/* Section break — a gradient hairline instead of a written label
            (same recipe as the explorer header divider). Works at both rail
            widths, so nothing fades or shifts on toggle. */}
        <div
          aria-hidden="true"
          style={{
            height: 1,
            margin: "12px 12px 8px",
            background:
              "linear-gradient(to right, transparent 0%, var(--border) 18%, var(--border) 82%, transparent 100%)",
            pointerEvents: "none",
          }}
        />

        <div
          ref={flip.trackRef}
          data-flip={flip.flip}
          style={{
            position: "relative",
            display: "flex",
            flexDirection: "column",
            alignItems: "stretch",
            gap: 6,
          }}
        >
          <span
            className="klide-flip-indicator klide-activity-bar-indicator"
            style={{ ...flip.style, width: "calc(100% - 16px)" }}
            aria-hidden="true"
          />
          {toolItems.map(({ id, label, Icon }) => {
            const isActive = active[id];
            const submenu = submenus?.[id];
            const hasSubmenu = !!submenu && submenu.items.length > 0;
            const inlineOpen = expanded && hasSubmenu && openInline.has(id);
            return (
              <div key={id} style={{ display: "flex", flexDirection: "column" }}>
                <button
                  ref={flip.setItemRef(id)}
                  onClick={(e) => {
                    setMenu(null);
                    onToggle(id, e.metaKey || e.ctrlKey);
                  }}
                  title={id === "ai" ? label : `${label}  (⌘+click to stack)`}
                  aria-label={label}
                  aria-pressed={isActive}
                  aria-haspopup={hasSubmenu ? "menu" : undefined}
                  data-active={isActive}
                  className="klide-activity-bar-item"
                  style={rowStyle(isActive)}
                  onMouseEnter={(e) => {
                    if (!isActive) e.currentTarget.style.color = "var(--fg-strong)";
                    scheduleOpen(id, e);
                  }}
                  onMouseLeave={(e) => {
                    if (!isActive) e.currentTarget.style.color = "var(--fg-subtle)";
                    scheduleClose();
                  }}
                >
                  <span style={{ flexShrink: 0, display: "inline-flex" }}><Icon /></span>
                  <span style={rowLabel}>{label}</span>
                  {expanded && hasSubmenu && (
                    <span
                      role="button"
                      tabIndex={0}
                      aria-label={`${inlineOpen ? "Collapse" : "Expand"} ${label} submenu`}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleInline(id);
                      }}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") {
                          e.preventDefault();
                          e.stopPropagation();
                          toggleInline(id);
                        }
                      }}
                      style={{
                        display: "grid",
                        placeItems: "center",
                        width: 20,
                        height: 20,
                        borderRadius: 6,
                        color: "var(--fg-dim)",
                        flexShrink: 0,
                      }}
                    >
                      <ChevronSmall open={inlineOpen} />
                    </span>
                  )}
                </button>
                {/* Inline submenu (expanded mode) — indented rows hanging off
                    a hairline connector under the icon, per the reference. */}
                {inlineOpen && submenu && (
                  <div style={{ position: "relative", margin: "2px 8px 2px 8px", paddingLeft: 30 }}>
                    <span
                      aria-hidden
                      style={{
                        position: "absolute",
                        left: 20,
                        top: 0,
                        bottom: 8,
                        width: 1,
                        background: "var(--border)",
                      }}
                    />
                    {submenu.items.map((item) => (
                      <button
                        key={item.key}
                        type="button"
                        className="klide-rail-flyout-row"
                        data-active={item.active ? "true" : undefined}
                        style={{ width: "100%" }}
                        onClick={() => item.onSelect()}
                      >
                        {item.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>

      {/* Zone break is pure space — no hairline notches; the rail stays one
          uninterrupted surface. */}
      <div
        style={{
          padding: "10px 0 12px",
          display: "flex",
          flexDirection: "column",
          alignItems: "stretch",
          gap: 6,
        }}
      >
        {destinationItems.map(({ id, label, Icon }) => {
          const isActive = active[id];
          const hasSubmenu = !!submenus?.[id] && submenus[id]!.items.length > 0;
          return (
            <button
              key={id}
              onClick={() => {
                setMenu(null);
                onToggle(id);
              }}
              title={label}
              aria-label={label}
              aria-pressed={isActive}
              aria-haspopup={hasSubmenu ? "menu" : undefined}
              data-active={isActive}
              className="klide-activity-bar-item klide-activity-bar-destination"
              style={rowStyle(isActive)}
              onMouseEnter={(e) => {
                if (!isActive) e.currentTarget.style.color = "var(--fg-strong)";
                scheduleOpen(id, e);
              }}
              onMouseLeave={(e) => {
                if (!isActive) e.currentTarget.style.color = "var(--fg-subtle)";
                scheduleClose();
              }}
            >
              <span
                aria-hidden
                style={{ width: 18, height: 18, flexShrink: 0, display: "grid", placeItems: "center" }}
              >
                <Icon />
              </span>
              <span style={rowLabel}>{label}</span>
              {expanded ? (
                isActive && (
                  <span
                    aria-hidden
                    style={{
                      width: 3,
                      height: 3,
                      borderRadius: "50%",
                      background: "var(--accent)",
                      flexShrink: 0,
                    }}
                  />
                )
              ) : (
                <span aria-hidden data-visible={isActive} className="klide-activity-bar-dock-dot" />
              )}
            </button>
          );
        })}

        {/* Identity row — the same foot the Focus rail ends on: the profile
            card takes the space its name and host need, and the view switch
            hangs off the ragged right edge. Collapsed, the card narrows to the
            avatar and the switch drops onto its own line. */}
        <div
          className="klide-rail-identity-row"
          data-collapsed={!expanded || undefined}
          style={{ margin: "2px 8px 0" }}
        >
          <button
            type="button"
            className="klide-rail-profile"
            aria-label={`Open ${profileDest.label.toLowerCase()}`}
            aria-pressed={active.profile}
            title={profileDest.label}
            data-active={active.profile}
            onClick={() => {
              setMenu(null);
              onToggle("profile");
            }}
          >
            <span className="klide-rail-profile-avatar" aria-hidden>
              {initialsOf(username || "?")}
              {avatarUrl ? (
                <img
                  src={avatarUrl}
                  alt=""
                  onError={(event) => { event.currentTarget.style.display = "none"; }}
                />
              ) : null}
            </span>
            <span className="klide-rail-profile-identity" style={{ opacity: expanded ? 1 : 0 }}>
              <span className="klide-rail-profile-name">{username || "Local profile"}</span>
              <span className="klide-rail-profile-host">{hostname}</span>
            </span>
          </button>
          {onEnterFocus && (
            <button
              type="button"
              className="klide-rail-view-switch"
              aria-label="Focus layout"
              title="Focus layout"
              onClick={onEnterFocus}
            >
              <FocusLayoutIcon size={14} />
            </button>
          )}
        </div>
      </div>

      {/* Collapsed-mode flyout — a soft rounded card beside the rail
          (portal, so no clipping). Rows use the app-wide soft-fill recipe. */}
      {menu &&
        openSubmenu &&
        createPortal(
          <div
            role="menu"
            aria-label={openSubmenu.title}
            className="klide-rail-flyout"
            style={{
              top: Math.max(8, Math.min(menu.top, window.innerHeight - 340)),
              left: menu.left,
              zIndex: Z.popover,
            }}
            onMouseEnter={cancelClose}
            onMouseLeave={scheduleClose}
          >
            <div className="klide-rail-flyout-title">{openSubmenu.title}</div>
            {openSubmenu.items.map((item) => (
              <button
                key={item.key}
                type="button"
                role="menuitem"
                className="klide-rail-flyout-row"
                data-active={item.active ? "true" : undefined}
                onClick={() => {
                  setMenu(null);
                  item.onSelect();
                }}
              >
                {item.label}
              </button>
            ))}
          </div>,
          document.body
        )}
    </nav>
  );
}

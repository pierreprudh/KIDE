import { invoke } from "@tauri-apps/api/core";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";

type TodoItem = {
  id: string;
  text: string;
  done: boolean;
  created_at: number;
  updated_at?: number;
};

type TodoEvent = {
  seq: number;
  action: "add" | "complete" | "uncomplete" | "edit" | "remove" | string;
  todo_id?: string | null;
  text?: string | null;
  previous_text?: string | null;
  done?: boolean | null;
  at: number;
};

type TodoStore = {
  todos: TodoItem[];
  next_id: number;
  events?: TodoEvent[];
  next_event_id?: number;
};

const DISMISSED_TODOS_KEY = "klide.todoStrip.dismissedCompleted";

// ~5 rows before the list scrolls; keeps the card off the conversation.
const MAX_LIST_HEIGHT = 118;

function readDismissedTodoStrips(): Record<string, string> {
  try {
    const raw = localStorage.getItem(DISMISSED_TODOS_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, string>)
      : {};
  } catch {
    return {};
  }
}

function writeDismissedTodoStrips(map: Record<string, string>) {
  try {
    const entries = Object.entries(map).slice(-200);
    localStorage.setItem(DISMISSED_TODOS_KEY, JSON.stringify(Object.fromEntries(entries)));
  } catch {
    /* localStorage is convenience only */
  }
}

function dismissalKey(workspaceRoot: string | null, conversationId: string): string {
  return `${workspaceRoot ?? "no-workspace"}::${conversationId}`;
}

// The shape of the plan, not its progress: hiding a plan has to survive the
// agent ticking items off, and only a *different* plan brings the strip back.
function planSignature(items: TodoItem[]): string {
  return `${items.length}:${items.map((item) => item.id).join("|")}`;
}

function planWasHidden(
  workspaceRoot: string | null,
  conversationId: string,
  signature: string
): boolean {
  return readDismissedTodoStrips()[dismissalKey(workspaceRoot, conversationId)] === signature;
}

function rememberPlanHidden(
  workspaceRoot: string | null,
  conversationId: string,
  signature: string
) {
  const map = readDismissedTodoStrips();
  map[dismissalKey(workspaceRoot, conversationId)] = signature;
  writeDismissedTodoStrips(map);
}

function CheckIcon() {
  return (
    <svg className="klide-todo-check" width="7" height="7" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M20 6L9 17l-5-5" />
    </svg>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      width="12"
      height="12"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      style={{ transform: `rotate(${open ? 180 : 0}deg)`, transition: "transform 0.15s ease" }}
    >
      <path d="M6 9l6 6 6-6" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 6 6 18M6 6l12 12" />
    </svg>
  );
}

function safeScope(scope: string): string {
  return scope.replace(/[^A-Za-z0-9_-]/g, "_");
}

// Progress is the rule itself: the hairline that separates the header from the
// list fills with accent as items complete. One line doing two jobs — structure
// and progress — instead of a stubby inline bar plus a percentage read-out.
function ProgressRule({ percent, inset }: { percent: number; inset: number }) {
  return (
    <span
      aria-hidden
      style={{
        position: "relative",
        display: "block",
        height: 1,
        marginLeft: -inset,
        marginRight: -inset,
        background: "var(--border)",
      }}
    >
      <span
        style={{
          position: "absolute",
          inset: "0 auto 0 0",
          width: `${percent}%`,
          background: "var(--accent)",
          transition: "width var(--motion-slow) var(--ease-out)",
        }}
      />
    </span>
  );
}

// "3/7" in mono — a count is more useful than a rounded percentage, and it
// doesn't read as dead ("0%") at the start of a plan.
function CountLabel({ done, total }: { done: number; total: number }) {
  if (total === 0) return null;
  return (
    <span
      style={{
        color: "var(--fg-subtle)",
        fontSize: 11,
        fontWeight: 500,
        fontFamily: "var(--font-mono)",
        fontVariantNumeric: "tabular-nums",
        whiteSpace: "nowrap",
      }}
    >
      {done}/{total}
    </span>
  );
}

function GoalLine({ goal, size }: { goal: string; size: number }) {
  return (
    <span style={{ display: "flex", alignItems: "baseline", gap: 7, minWidth: 0, whiteSpace: "nowrap" }}>
      <span
        style={{
          flex: "none",
          color: "var(--fg-dim)",
          fontSize: 9.5,
          fontWeight: 600,
          letterSpacing: "0.09em",
          textTransform: "uppercase",
        }}
      >
        Goal
      </span>
      <span
        style={{
          minWidth: 0,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          color: "var(--fg-strong)",
          fontSize: size,
          fontWeight: 460,
        }}
      >
        {goal}
      </span>
    </span>
  );
}

// Opaque narrow panel that floats over the bottom of the conversation and
// docks onto the composer. Narrower than the chat, so messages stay visible in
// the side margins. No shadow — it cast a dark halo (the "black bars") in dark
// themes; the hairline border alone defines the panel. No backdrop-filter —
// solid surface (the webview has a known backdrop-filter bug).
const glassCard: CSSProperties = {
  background: "var(--bg-elevated)",
  border: "none",
  borderTop: "1px solid var(--border-strong)",
};

// Floats just above the composer, INSIDE the conversation area. It must not
// overlap the composer (no negative bottom): the chatbox is wider than this
// narrow bar, so any overlap makes the composer's rounded top corners peek out
// on either side of the bar.
const dockWrap: CSSProperties = {
  position: "absolute",
  left: 0,
  right: 0,
  bottom: 0,
  display: "flex",
  justifyContent: "center",
  pointerEvents: "none",
  zIndex: 6,
};

export function TodoStrip({
  workspaceRoot,
  conversationId,
  goal: goalProp,
  onDockHeightChange,
}: {
  workspaceRoot: string | null;
  conversationId: string;
  goal?: string;
  onDockHeightChange?: (height: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [items, setItems] = useState<TodoItem[]>([]);
  const [events, setEvents] = useState<TodoEvent[]>([]);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const dockRef = useRef<HTMLDivElement | null>(null);
  const listInnerRef = useRef<HTMLDivElement | null>(null);
  const [contentHeight, setContentHeight] = useState(0);

  useEffect(() => {
    // Drop the previous conversation's list right away so it never flashes
    // under a freshly-started one before the new file loads.
    setItems([]);
    setEvents([]);
    if (!workspaceRoot) return;

    const todoPath = `.agents/todos/${safeScope(conversationId)}.json`;
    async function load() {
      try {
        const raw = await invoke<string>("read_text_file", {
          workspaceRoot,
          path: `${workspaceRoot}/${todoPath}`,
        });
        const store: TodoStore = JSON.parse(raw);
        setItems(store.todos ?? []);
        setEvents(store.events ?? []);
      } catch {
        setItems([]);
        setEvents([]);
      }
    }

    load();
    intervalRef.current = setInterval(load, 3000);
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
    };
  }, [workspaceRoot, conversationId]);

  useEffect(() => {
    setOpen(true);
    setDismissed(false);
  }, [conversationId]);

  const total = items.length;
  const done = items.filter((item) => item.done).length;
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);
  const recentEvents = [...events].sort((a, b) => b.seq - a.seq).slice(0, 5);
  const visibleItems = items;
  // Prefer the user's actual ask (the goal write-up) over the current step.
  const goal = goalProp?.replace(/\s+/g, " ").trim() || items[0]?.text || recentEvents[0]?.text || "Working through the plan";

  const allDone = total > 0 && done === total;
  const shownSignature = planSignature(items);

  // Hide is available at any point in a plan, not only once it finishes. The
  // signature is persisted so it survives a restart, and it keys on the plan's
  // shape — so ticking items off never resurrects a plan you dismissed, while
  // a genuinely new plan does come back.
  function hidePlan() {
    rememberPlanHidden(workspaceRoot, conversationId, shownSignature);
    setDismissed(true);
  }

  // When the plan finishes, collapse to the slim pill so the agent's final
  // output stays visible (a tall card would sit over it like a dark box). If
  // work resumes after a dismiss, bring the box back.
  useEffect(() => {
    if (allDone) setOpen(false);
    else setDismissed(false);
  }, [allDone]);

  useEffect(() => {
    // Restore a prior hide — the signature comparison handles staleness
    // (a different plan → show again).
    if (planWasHidden(workspaceRoot, conversationId, shownSignature)) {
      setDismissed(true);
    }
  }, [workspaceRoot, conversationId, shownSignature]);

  // An empty list means there is nothing to show, even when the store still
  // holds the events that emptied it — otherwise clearing the plan leaves a
  // ghost card with a goal header and no rows, holding the composer up.
  const visible = !dismissed && total > 0;

  // Measured before paint, so the list opens at its true height and only
  // *changes* to it animate — adding or clearing a task glides.
  useLayoutEffect(() => {
    const el = listInnerRef.current;
    if (el) setContentHeight(el.scrollHeight);
  }, [items, open]);
  const listHeight = Math.min(contentHeight, MAX_LIST_HEIGHT);

  // The card sizes to its rows now, so the composer offset has to be measured
  // rather than assumed from a fixed height.
  useEffect(() => {
    if (!visible) {
      onDockHeightChange?.(0);
      return;
    }
    const el = dockRef.current;
    if (!el) return;
    const report = () => onDockHeightChange?.(Math.round(el.getBoundingClientRect().height));
    report();
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => observer.disconnect();
  }, [visible, open, total, onDockHeightChange]);

  if (!visible) return null;

  return (
    <div ref={dockRef} style={dockWrap}>
      <section
        className="klide-todo-strip"
        aria-label="Agent todo progress"
        style={{
          ...glassCard,
          pointerEvents: "auto",
          position: "relative",
          width: "min(620px, calc(100% - 48px))",
          padding: "10px 16px 0",
          display: "grid",
          gridTemplateRows: "auto auto minmax(0, 1fr)",
          overflow: "hidden",
          borderRadius: "14px 14px 0 0",
          animation: "klide-todo-open-in var(--motion-slow) var(--ease-soft)",
        }}
      >
        {/* header: GOAL · title · count · collapse · hide. Doubles as the
            expand target, so the whole strip is one click when collapsed. */}
        <div
          role="button"
          tabIndex={0}
          aria-expanded={open}
          aria-label={open ? "Collapse agent todo panel" : "Expand agent todo panel"}
          onClick={() => setOpen((was) => !was)}
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              setOpen((was) => !was);
            }
          }}
          style={{
            display: "grid",
            gridTemplateColumns: "minmax(0, 1fr) auto auto",
            alignItems: "center",
            gap: 12,
            paddingBottom: 9,
            cursor: "pointer",
          }}
        >
          <GoalLine goal={goal} size={12.5} />
          <CountLabel done={done} total={total} />
          <span style={{ display: "flex", alignItems: "center", gap: 2 }}>
            <span style={{ width: 18, height: 18, display: "grid", placeItems: "center", color: "var(--fg-dim)" }}>
              <ChevronIcon open={open} />
            </span>
            <button
              onClick={(e) => { e.stopPropagation(); hidePlan(); }}
              aria-label="Hide this plan"
              style={{
                width: 18,
                height: 18,
                display: "grid",
                placeItems: "center",
                border: "none",
                background: "transparent",
                color: "var(--fg-dim)",
                cursor: "pointer",
              }}
            >
              <CloseIcon />
            </button>
          </span>
        </div>

        {/* Collapsed, the separator carries the progress; opening hands it over
            to the thread running through the tasks, so there is only ever one. */}
        <ProgressRule percent={open ? 0 : percent} inset={16} />

        {/* scrollable list: tasks threaded on one hairline, state carried by type */}
        <div
          className="klide-todo-list todo-scroll"
          aria-hidden={!open}
          style={{
            position: "relative",
            overflowY: "auto",
            height: open ? listHeight : 0,
            opacity: open ? 1 : 0,
          }}
        >
          {/* 3px of left room so the active mark's halo isn't clipped by the scroller */}
          <div ref={listInnerRef} style={{ padding: "8px 6px 10px 3px" }}>
            {visibleItems.map((item, idx) => {
              const active = !item.done && idx === visibleItems.findIndex((candidate) => !candidate.done);
              const isLast = idx === visibleItems.length - 1;
              return (
                <div
                  key={item.id}
                  className="klide-todo-row"
                  style={{
                    position: "relative",
                    display: "grid",
                    gridTemplateColumns: "11px minmax(0, 1fr)",
                    alignItems: "center",
                    gap: 10,
                    minHeight: 23,
                    animationDelay: `${Math.min(idx, 7) * 26}ms`,
                  }}
                >
                  {/* thread in: filled once the task above is done */}
                  {idx > 0 && (
                    <span
                      aria-hidden
                      className="klide-todo-link"
                      data-filled={visibleItems[idx - 1].done ? "1" : "0"}
                      style={{ top: 0, height: "50%" }}
                    >
                      <i />
                    </span>
                  )}
                  {/* thread out: filled once this task is done */}
                  {!isLast && (
                    <span
                      aria-hidden
                      className="klide-todo-link"
                      data-filled={item.done ? "1" : "0"}
                      style={{ top: "50%", bottom: 0 }}
                    >
                      <i />
                    </span>
                  )}
                  <span
                    className="klide-todo-mark"
                    data-state={item.done ? "done" : active ? "active" : "todo"}
                    style={{
                      position: "relative",
                      width: 10,
                      height: 10,
                      borderRadius: "50%",
                      display: "grid",
                      placeItems: "center",
                      boxSizing: "border-box",
                      // opaque so the thread breaks cleanly at each node
                      background: item.done ? "var(--accent)" : "var(--bg-elevated)",
                      border: item.done
                        ? "none"
                        : active
                          ? "1.5px solid color-mix(in srgb, var(--accent) 80%, transparent)"
                          : "1px solid color-mix(in srgb, var(--fg-dim) 55%, transparent)",
                      color: item.done ? "var(--bg-elevated)" : "transparent",
                    }}
                  >
                    {item.done && <CheckIcon />}
                  </span>
                  <span
                    style={{
                      minWidth: 0,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                      fontSize: 12.5,
                      lineHeight: "18px",
                      fontWeight: active ? 500 : 400,
                      color: item.done ? "var(--fg-dim)" : active ? "var(--fg-strong)" : "var(--fg-subtle)",
                      textDecoration: item.done ? "line-through" : "none",
                      textDecorationColor: item.done ? "color-mix(in srgb, var(--fg-dim) 55%, transparent)" : undefined,
                      transition: "color var(--motion-slow) var(--ease-soft)",
                    }}
                  >
                    {item.text}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      </section>
    </div>
  );
}

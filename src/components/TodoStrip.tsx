import { invoke } from "@tauri-apps/api/core";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { formatSpan } from "../time";
import {
  attemptLabel,
  formatOffset,
  historyOf,
  planStartedAt,
  workFloors,
  type TodoEvent,
  type TodoItem,
  type TodoMoment,
} from "../todoHistory";
import { useElapsed } from "./ai/WorkingRow";
import "./todoStrip.css";

type TodoStore = {
  todos: TodoItem[];
  next_id: number;
  events?: TodoEvent[];
  next_event_id?: number;
};

const DISMISSED_TODOS_KEY = "klide.todoStrip.dismissedCompleted";

// ~5 rows before the list scrolls; keeps the card off the conversation. A
// row with its drawer open gets more, so the history is readable without
// scrolling inside a scroller.
const MAX_LIST_HEIGHT = 118;
const MAX_LIST_HEIGHT_OPEN = 214;

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
    <svg className="klide-todo-check" width="8" height="8" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3.6" strokeLinecap="round" strokeLinejoin="round">
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
        fontSize: 10.5,
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

// The mark at the head of each row says what state the step is in without a
// colored dot: a pending step shows its number, the step being worked on wears
// a thin arc sweeping around that number, a finished step closes to a check.
// Numbers instead of hollow circles — type over shape, and "3" already tells
// you where in the plan you are.
const MARK = 14;
// The header ends in two 18px icon boxes (collapse, hide). Rows end in the same
// width so their chevron sits under the header's, and the figures on every row
// stop at the same x as the header count — one right edge for the whole strip.
const ICON = 18;
const ICON_COLUMN = ICON * 2 + 2;
const RIGHT_GAP = 12;

function StepMark({ index, state }: { index: number; state: "todo" | "active" | "done" }) {
  const r = (MARK - 1.5) / 2;
  const c = 2 * Math.PI * r;
  return (
    <span
      className="klide-todo-mark"
      data-state={state}
      style={{
        position: "relative",
        width: MARK,
        height: MARK,
        borderRadius: "50%",
        display: "grid",
        placeItems: "center",
        boxSizing: "border-box",
        // opaque so the thread breaks cleanly at each node
        background: state === "done" ? "var(--accent)" : "var(--bg-elevated)",
        color: state === "done" ? "var(--bg-elevated)" : state === "active" ? "var(--fg-strong)" : "var(--fg-dim)",
        fontFamily: "var(--font-mono)",
        fontSize: 9,
        fontWeight: 600,
        lineHeight: 1,
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {state !== "done" && (
        <svg width={MARK} height={MARK} viewBox={`0 0 ${MARK} ${MARK}`} aria-hidden style={{ position: "absolute", inset: 0 }}>
          <circle
            cx={MARK / 2}
            cy={MARK / 2}
            r={r}
            fill="none"
            stroke={state === "active" ? "var(--border)" : "color-mix(in srgb, var(--fg-dim) 45%, transparent)"}
            strokeWidth={state === "active" ? 1.5 : 1}
          />
        </svg>
      )}
      {state === "active" && (
        <svg className="klide-todo-ring" width={MARK} height={MARK} viewBox={`0 0 ${MARK} ${MARK}`} aria-hidden>
          <circle
            cx={MARK / 2}
            cy={MARK / 2}
            r={r}
            fill="none"
            stroke="var(--accent)"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeDasharray={`${c * 0.3} ${c * 0.7}`}
          />
        </svg>
      )}
      {state === "done" ? <CheckIcon /> : <span style={{ position: "relative" }}>{index + 1}</span>}
    </span>
  );
}

// The active step counts up beside its label, the same mono figures the
// Working row and the thinking header use — one language for "busy".
function LiveSince({ since }: { since: number }) {
  const elapsed = useElapsed(since);
  return <>{elapsed}</>;
}

const MOMENT_LABEL: Record<TodoMoment["kind"], string> = {
  planned: "Planned",
  reworded: "Reworded",
  done: "Done",
  reopened: "Reopened",
};

function MomentLine({ moment, index, planStart }: { moment: TodoMoment; index: number; planStart: number }) {
  const label =
    moment.kind === "done" && moment.span !== undefined && moment.span >= 1000
      ? `Done in ${formatSpan(moment.span)}`
      : MOMENT_LABEL[moment.kind];
  return (
    <div
      className="klide-todo-moment"
      style={{ ["--i" as string]: index, display: "grid", gridTemplateColumns: "minmax(0, 1fr) auto", columnGap: 10, alignItems: "baseline" }}
    >
      <span style={{ minWidth: 0, fontSize: 11.5, lineHeight: "17px", color: "var(--fg-subtle)" }}>
        {label}
        {moment.was && (
          <span
            style={{
              display: "block",
              overflow: "hidden",
              textOverflow: "ellipsis",
              whiteSpace: "nowrap",
              color: "var(--fg-dim)",
              fontStyle: "italic",
            }}
          >
            was “{moment.was}”
          </span>
        )}
      </span>
      <span
        style={{
          fontFamily: "var(--font-mono)",
          fontSize: 10.5,
          lineHeight: "17px",
          color: "var(--fg-dim)",
          fontVariantNumeric: "tabular-nums",
        }}
      >
        {formatOffset(moment.at - planStart)}
      </span>
    </div>
  );
}

// One step of the plan. The head is a button: click it and the row's history
// drops down under it — when it was planned, how it was reworded, whether it
// was reopened, how long it took — threaded on the same line the rows hang
// from. Same expandable grammar as the thinking block, so a reader who has
// opened one knows how to open the other.
function TodoRow({
  item,
  index,
  active,
  isLast,
  threadInFilled,
  open,
  onToggle,
  events,
  planStart,
  startedAfter,
}: {
  item: TodoItem;
  index: number;
  active: boolean;
  isLast: boolean;
  threadInFilled: boolean;
  open: boolean;
  onToggle: () => void;
  events: TodoEvent[];
  planStart: number;
  startedAfter: number;
}) {
  const history = historyOf(item, events, startedAfter);
  const tries = attemptLabel(history.reopened);
  const state = item.done ? "done" : active ? "active" : "todo";

  return (
    <div
      className="klide-todo-row"
      data-open={open ? "1" : "0"}
      style={{ position: "relative", animationDelay: `${Math.min(index, 7) * 26}ms` }}
    >
      {/* thread in: filled once the task above is done */}
      {index > 0 && (
        <span aria-hidden className="klide-todo-link" data-filled={threadInFilled ? "1" : "0"} style={{ top: 0, height: 12, left: MARK / 2 - 0.5 }}>
          <i />
        </span>
      )}
      {/* thread out: filled once this task is done; runs on through the open drawer */}
      {(!isLast || open) && (
        <span aria-hidden className="klide-todo-link" data-filled={item.done ? "1" : "0"} style={{ top: 12, bottom: isLast ? 6 : 0, left: MARK / 2 - 0.5 }}>
          <i />
        </span>
      )}

      <button
        type="button"
        className="klide-todo-row-head"
        aria-expanded={open}
        onClick={onToggle}
        style={{
          display: "grid",
          gridTemplateColumns: `${MARK}px minmax(0, 1fr) auto ${ICON_COLUMN}px`,
          alignItems: "center",
          columnGap: RIGHT_GAP,
          minHeight: 24,
          padding: 0,
        }}
      >
        <StepMark index={index} state={state} />
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
        {/* the row's own figures: a live count while active, the span once done,
            and a quiet "2nd try" when the step had to be reopened */}
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: 10.5,
            color: "var(--fg-dim)",
            fontVariantNumeric: "tabular-nums",
            whiteSpace: "nowrap",
            display: "inline-flex",
            gap: 8,
          }}
        >
          {tries && <span>{tries}</span>}
          {active && <LiveSince since={history.attemptStartedAt} />}
          {item.done && history.doneIn !== undefined && history.doneIn >= 1000 && <span>{formatSpan(history.doneIn)}</span>}
        </span>
        <span className="klide-todo-chev" aria-hidden style={{ width: ICON, height: ICON, display: "grid", placeItems: "center", color: "var(--fg-dim)" }}>
          <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M6 9l6 6 6-6" />
          </svg>
        </span>
      </button>

      <div className="klide-todo-drawer" data-open={open ? "1" : "0"} aria-hidden={!open}>
        <div>
          <div style={{ padding: `2px ${ICON_COLUMN + RIGHT_GAP}px 6px ${MARK + RIGHT_GAP}px`, display: "flex", flexDirection: "column", gap: 1 }}>
            {history.moments.map((moment, i) => (
              <MomentLine key={`${moment.kind}-${moment.at}-${i}`} moment={moment} index={i} planStart={planStart} />
            ))}
          </div>
        </div>
      </div>
    </div>
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
  // One drawer at a time: the strip sits over the conversation, and two open
  // histories would push the answer further out of view than they are worth.
  const [openRow, setOpenRow] = useState<string | null>(null);

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
    setOpenRow(null);
  }, [conversationId]);

  const total = items.length;
  const done = items.filter((item) => item.done).length;
  const percent = total === 0 ? 0 : Math.round((done / total) * 100);
  const recentEvents = [...events].sort((a, b) => b.seq - a.seq).slice(0, 5);
  const visibleItems = items;
  const firstOpen = visibleItems.findIndex((candidate) => !candidate.done);
  const planStart = planStartedAt(items, events);
  // Each step's clock starts when the step before it closed, so the live count
  // and the spans measure the work on that step, not the age of the plan.
  const floors = workFloors(items, events);
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
  }, [items, open, openRow]);
  const listHeight = Math.min(contentHeight, openRow ? MAX_LIST_HEIGHT_OPEN : MAX_LIST_HEIGHT);

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
            gridTemplateColumns: `minmax(0, 1fr) auto ${ICON_COLUMN}px`,
            alignItems: "center",
            columnGap: RIGHT_GAP,
            paddingBottom: 9,
            cursor: "pointer",
          }}
        >
          <GoalLine goal={goal} size={12.5} />
          <CountLabel done={done} total={total} />
          <span style={{ display: "flex", alignItems: "center", gap: 2 }}>
            <span style={{ width: ICON, height: ICON, display: "grid", placeItems: "center", color: "var(--fg-dim)" }}>
              <ChevronIcon open={open} />
            </span>
            <button
              onClick={(e) => { e.stopPropagation(); hidePlan(); }}
              aria-label="Hide this plan"
              style={{
                width: ICON,
                height: ICON,
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
            marginLeft: -3,
            height: open ? listHeight : 0,
            opacity: open ? 1 : 0,
          }}
        >
          {/* 3px of ring room on the left is paid for by the scroller's margin, so
              the marks still start where the header text does */}
          <div ref={listInnerRef} style={{ padding: "8px 0 10px 3px" }}>
            {visibleItems.map((item, idx) => (
              <TodoRow
                key={item.id}
                item={item}
                index={idx}
                active={!item.done && idx === firstOpen}
                isLast={idx === visibleItems.length - 1}
                threadInFilled={idx > 0 && visibleItems[idx - 1].done}
                open={openRow === item.id}
                onToggle={() => setOpenRow((was) => (was === item.id ? null : item.id))}
                events={events}
                planStart={planStart}
                startedAfter={floors[idx] ?? 0}
              />
            ))}
          </div>
        </div>
      </section>
    </div>
  );
}

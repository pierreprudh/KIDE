// How one task in an agent's plan got to where it is.
//
// The todo store keeps a flat list of items plus the mutations that shaped it:
// a step gets added, reworded, ticked, sometimes un-ticked and tried again.
// Rendered as a list of checkboxes that history is invisible, and it is the
// interesting part — a step the agent reworded twice and reopened once says
// more about how the run went than the fact that it eventually closed.
//
// This module folds those events into a per-task timeline the strip can open
// under each row. It is pure on purpose: timestamps come in, labels and spans
// come out, and the clock is a parameter so it can be tested without freezing
// time.

export type TodoItem = {
  id: string;
  text: string;
  done: boolean;
  created_at: number;
  updated_at?: number;
};

export type TodoEvent = {
  seq: number;
  action: "add" | "complete" | "uncomplete" | "edit" | "remove" | string;
  todo_id?: string | null;
  text?: string | null;
  previous_text?: string | null;
  done?: boolean | null;
  at: number;
};

/** One line of a task's drawer. */
export type TodoMoment = {
  kind: "planned" | "reworded" | "done" | "reopened";
  /** Epoch ms. */
  at: number;
  /** The wording this step had before an edit — the agent's earlier thought. */
  was?: string;
  /** For "done": how long the step was open, in ms. */
  span?: number;
};

export type TodoHistory = {
  moments: TodoMoment[];
  /** When the current attempt started: the add, or the last reopen. */
  attemptStartedAt: number;
  /** How long the finished step took, ms; undefined while it is still open. */
  doneIn?: number;
  /** How many times the step was ticked and then reopened. */
  reopened: number;
};

/**
 * `startedAfter` is when the agent could first have turned to this step — the
 * moment the step before it closed. A plan is written all at once, so every
 * step's add sits at the plan's start; measured from there, the step in hand
 * would show the whole plan's age and the fourth step's span would swallow the
 * first three. The clock starts at the later of the add and that floor; a
 * reopen still restarts it.
 */
export function historyOf(item: TodoItem, events: TodoEvent[], startedAfter = 0): TodoHistory {
  const own = events
    .filter((e) => e.todo_id === item.id)
    .sort((a, b) => a.seq - b.seq);

  const moments: TodoMoment[] = [];
  let attemptStartedAt = Math.max(item.created_at, startedAfter);
  let doneIn: number | undefined;
  let reopened = 0;
  let sawAdd = false;

  for (const e of own) {
    switch (e.action) {
      case "add":
        sawAdd = true;
        attemptStartedAt = Math.max(e.at, startedAfter);
        moments.push({ kind: "planned", at: e.at });
        break;
      case "edit":
        moments.push({ kind: "reworded", at: e.at, was: e.previous_text ?? undefined });
        break;
      case "complete": {
        const span = Math.max(0, e.at - attemptStartedAt);
        doneIn = span;
        moments.push({ kind: "done", at: e.at, span });
        break;
      }
      case "uncomplete":
        reopened += 1;
        doneIn = undefined;
        attemptStartedAt = e.at;
        moments.push({ kind: "reopened", at: e.at });
        break;
      default:
        break;
    }
  }

  // Older stores kept items but not their events; the item itself still knows
  // when it was planned, so the drawer is never empty.
  if (!sawAdd) moments.unshift({ kind: "planned", at: item.created_at });

  // The list is the truth about *now*: if it says done but the log's tail was
  // trimmed (the store caps events), trust the list and the item's own clock.
  if (item.done && doneIn === undefined) {
    const at = item.updated_at ?? item.created_at;
    doneIn = Math.max(0, at - attemptStartedAt);
    if (moments[moments.length - 1]?.kind !== "done") moments.push({ kind: "done", at, span: doneIn });
  }
  if (!item.done && doneIn !== undefined) doneIn = undefined;

  return { moments, attemptStartedAt, doneIn, reopened };
}

/** When each step's clock may start: the close of the latest step before it in
 *  the plan, or 0 for the first. Feed the result to `historyOf` as
 *  `startedAfter` so spans and the live count measure the work, not the plan. */
export function workFloors(items: TodoItem[], events: TodoEvent[]): number[] {
  const floors: number[] = [];
  let latestClose = 0;
  for (const item of items) {
    floors.push(latestClose);
    if (!item.done) continue;
    for (const m of historyOf(item, events).moments) {
      if (m.kind === "done") latestClose = Math.max(latestClose, m.at);
    }
  }
  return floors;
}

/** When the plan began — the earliest thing that happened to any of its steps.
 *  Drawer times are offsets from here, so "+12s" reads as a timeline instead
 *  of a column of wall-clock stamps that all say the same minute. */
export function planStartedAt(items: TodoItem[], events: TodoEvent[]): number {
  let start = Number.POSITIVE_INFINITY;
  for (const item of items) start = Math.min(start, item.created_at);
  for (const e of events) start = Math.min(start, e.at);
  return Number.isFinite(start) ? start : 0;
}

/** "+0s", "+12s", "+1m 4s" — a timeline offset in the same mono voice as the
 *  live timers, precise to the second because steps often close seconds apart. */
export function formatOffset(ms: number): string {
  const sec = Math.max(0, Math.round(ms / 1000));
  if (sec < 60) return `+${sec}s`;
  const min = Math.floor(sec / 60);
  const rest = sec % 60;
  return rest ? `+${min}m ${rest}s` : `+${min}m`;
}

/** "2nd try", "3rd try" — the row's quiet admission that a step was reopened. */
export function attemptLabel(reopened: number): string | null {
  if (reopened <= 0) return null;
  const n = reopened + 1;
  const suffix = n % 10 === 2 && n % 100 !== 12 ? "nd" : n % 10 === 3 && n % 100 !== 13 ? "rd" : "th";
  return `${n}${suffix} try`;
}

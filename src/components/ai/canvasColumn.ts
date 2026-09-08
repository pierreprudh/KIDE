// The Focus canvas' right-hand column, as a rule rather than a render.
//
// Three things can sit there — the plan, a run's result, a question the run is
// parked on — and each can be a *card* (a window) or a *mark* (the pill a
// folded one leaves behind). Mixing those two up is what put a close button in
// an empty corner and let a folded plan's mark sit over the prose: the column
// knew whether the plan was "visible", which answers neither question.
//
// So the geometry is decided here, in one place, from what each slot is
// actually showing.

import type { TodoStripSlot } from "../TodoStrip";

/** The column's own width range. Narrower than this and it is a corner. */
export const COLUMN_MAX = 320;
export const COLUMN_MIN = 232;

/** Prose keeps at least this much before the column takes any of the canvas. */
const PROSE_MIN = 560;

/** The column's margins, left and right of it (18px each). */
const COLUMN_MARGINS = 36;

/** A folded corner still needs a lane of its own, or marks sit over the text. */
const MARK_LANE = 76;

/** Below this the entry drops its words for its mark. */
const COMPACT_BELOW = 260;

export type ColumnInput = {
  /** What the plan is showing (TodoStrip reports it). */
  planSlot: TodoStripSlot;
  /** What the result is showing. It rests as a mark — evidence to peek at,
   *  not a thing to watch — and becomes a card only once the reader opens it,
   *  which is when the column owes it a window's width. */
  resultSlot: TodoStripSlot;
  /** A question the run is parked on. */
  questionUp: boolean;
  /** The reader closed the column. A question overrides it: that card holds
   *  the run, and hiding it strands the run with no way to answer. */
  hidden: boolean;
  /** Measured canvas width; 0 means "not measured yet", so assume roomy. */
  canvasWidth: number;
};

export type ColumnGeometry = {
  /** Column width in px — a share of the canvas, clamped to its range. */
  width: number;
  /** Entries drop their words at this size. */
  compact: boolean;
  /** A window is up: the column takes its full width. */
  cardsUp: boolean;
  /** Only marks are up: the column takes a lane, not a panel. */
  marksUp: boolean;
  /** What the conversation gives up on its right. */
  inset: number;
  /** Whether to draw the column's close control. It belongs to cards: with
   *  nothing but marks left there is nothing for it to close. */
  showClose: boolean;
  /** Whether the plan renders folded to its mark. */
  planFolded: boolean;
};

export function columnGeometry({ planSlot, resultSlot, questionUp, hidden, canvasWidth }: ColumnInput): ColumnGeometry {
  // A question is never hidden, so it also un-hides everything beside it: a
  // reader answering one should see the plan it came from.
  const closed = hidden && !questionUp;
  const width = canvasWidth === 0
    ? COLUMN_MAX
    : Math.max(COLUMN_MIN, Math.min(COLUMN_MAX, canvasWidth - PROSE_MIN - COLUMN_MARGINS));

  // Plan and question stay windows until the reader closes them; a result is a
  // window only while it is open. Marks are what is left over — and the corner
  // keeps them whether the column is open or closed, so a finished run never
  // vanishes from the top right.
  const cardsUp = !closed && (planSlot === "card" || questionUp || resultSlot === "card");
  const marksUp = !cardsUp && (planSlot !== "none" || resultSlot !== "none");

  return {
    width,
    compact: width < COMPACT_BELOW,
    cardsUp,
    marksUp,
    inset: cardsUp ? width + COLUMN_MARGINS : marksUp ? MARK_LANE : 0,
    showClose: cardsUp,
    planFolded: closed,
  };
}

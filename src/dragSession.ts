// One mouse-drag session, for the twelve places that were each rolling their own.
//
// Every drag-to-resize handle in the app repeated the same ~14 lines: stash the
// body cursor and user-select, override them, add `mousemove` + `mouseup`, and on
// release restore both and remove both listeners. Only the 3-line move body ever
// differed. Twelve verbatim copies is twelve chances to forget the restore — and
// a body left at `col-resize` with text selection disabled is a stuck-feeling app
// with no obvious cause.
//
// `SplitPane` exists for one of these cases and none of the other eleven used it,
// because it is a *layout* component: it owns the two panes as well as the
// divider. This is the smaller thing they all actually needed.

export type DragSession = {
  /** Called for every pointer move until release. */
  onMove: (event: MouseEvent) => void;
  /** Called once on release, after the cursor and selection are restored. */
  onDone?: () => void;
  /** Body cursor for the duration — `col-resize` for a vertical divider,
   *  `row-resize` for a horizontal one. */
  cursor: "col-resize" | "row-resize" | "grabbing";
};

/**
 * Take over the pointer until the button is released.
 *
 * Text selection is suppressed for the duration: without it, dragging across
 * the editor selects code, which both looks broken and steals the drag.
 *
 * Returns a function that ends the session early — for a component that unmounts
 * mid-drag and would otherwise leave the body overridden and the listeners live.
 */
export function beginDragSession({ onMove, onDone, cursor }: DragSession): () => void {
  const previousCursor = document.body.style.cursor;
  const previousSelect = document.body.style.userSelect;
  document.body.style.cursor = cursor;
  document.body.style.userSelect = "none";

  let finished = false;
  function finish() {
    if (finished) return;
    finished = true;
    document.body.style.cursor = previousCursor;
    document.body.style.userSelect = previousSelect;
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", finish);
    onDone?.();
  }

  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", finish);
  return finish;
}

import { describe, expect, it } from "vitest";

import { columnGeometry, COLUMN_MAX, COLUMN_MIN } from "./canvasColumn";

const roomy = { planSlot: "none", resultSlot: "none", questionUp: false, hidden: false, canvasWidth: 1210 } as const;

describe("canvas column geometry", () => {
  it("gives the canvas back when there is nothing in the corner", () => {
    const g = columnGeometry(roomy);
    expect(g.cardsUp).toBe(false);
    expect(g.marksUp).toBe(false);
    expect(g.inset).toBe(0);
    expect(g.showClose).toBe(false);
  });

  it("takes the column's width for a card", () => {
    const g = columnGeometry({ ...roomy, planSlot: "card" });
    expect(g.cardsUp).toBe(true);
    expect(g.inset).toBe(COLUMN_MAX + 36);
    expect(g.showClose).toBe(true);
  });

  // The bug this module exists for: closing the plan left the column's own
  // close button standing in a corner that had nothing left to close, and the
  // mark the plan folded to had no lane, so prose ran under it.
  it("keeps a lane for a folded plan's mark and hides the close with it", () => {
    const g = columnGeometry({ ...roomy, planSlot: "mark" });
    expect(g.cardsUp).toBe(false);
    expect(g.marksUp).toBe(true);
    expect(g.inset).toBe(76);
    expect(g.showClose).toBe(false);
  });

  it("keeps that lane when the reader closes the column on cards", () => {
    const g = columnGeometry({ ...roomy, planSlot: "card", resultSlot: "mark", hidden: true });
    expect(g.cardsUp).toBe(false);
    expect(g.marksUp).toBe(true);
    expect(g.inset).toBe(76);
    expect(g.planFolded).toBe(true);
  });

  // "A document or review should stay in icons; question and todo stay until
  // closed." A result at rest is a mark either way — the corner keeps it when
  // the column is closed, and it earns a window only once opened.
  it("keeps a result in the corner as an icon, open column or closed", () => {
    for (const hidden of [false, true]) {
      const g = columnGeometry({ ...roomy, resultSlot: "mark", hidden });
      expect(g.cardsUp).toBe(false);
      expect(g.marksUp).toBe(true);
      expect(g.inset).toBe(76);
      expect(g.showClose).toBe(false);
    }
  });
  it("gives an opened result the column's width", () => {
    const g = columnGeometry({ ...roomy, resultSlot: "card" });
    expect(g.cardsUp).toBe(true);
    expect(g.inset).toBe(COLUMN_MAX + 36);
    expect(g.showClose).toBe(true);
  });
  it("asks for nothing when a closed column has nothing to mark", () => {
    expect(columnGeometry({ ...roomy, hidden: true }).inset).toBe(0);
  });

  // A parked question holds the run: it cannot be closed away, and it brings
  // the plan it came from back with it.
  it("overrides a closed column while a question waits", () => {
    const g = columnGeometry({ ...roomy, planSlot: "card", questionUp: true, hidden: true });
    expect(g.cardsUp).toBe(true);
    expect(g.showClose).toBe(true);
    expect(g.planFolded).toBe(false);
  });

  it("shrinks with the canvas and goes compact in a corner", () => {
    expect(columnGeometry({ ...roomy, canvasWidth: 900 }).width).toBe(304);
    expect(columnGeometry({ ...roomy, canvasWidth: 900 }).compact).toBe(false);
    const tight = columnGeometry({ ...roomy, canvasWidth: 700 });
    expect(tight.width).toBe(COLUMN_MIN);
    expect(tight.compact).toBe(true);
  });

  it("assumes the roomy case before the canvas has been measured", () => {
    expect(columnGeometry({ ...roomy, canvasWidth: 0 }).width).toBe(COLUMN_MAX);
  });
});

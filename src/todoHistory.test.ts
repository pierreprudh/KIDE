import { describe, expect, it } from "vitest";
import { attemptLabel, formatOffset, historyOf, planStartedAt, workFloors, type TodoEvent, type TodoItem } from "./todoHistory";

const T0 = 1_700_000_000_000;
const item = (over: Partial<TodoItem> = {}): TodoItem => ({
  id: "T1",
  text: "Wire the drawer",
  done: false,
  created_at: T0,
  updated_at: T0,
  ...over,
});
const ev = (seq: number, action: string, at: number, extra: Partial<TodoEvent> = {}): TodoEvent => ({
  seq,
  action,
  todo_id: "T1",
  at,
  ...extra,
});

describe("historyOf", () => {
  it("a freshly planned step has one moment and no span", () => {
    const h = historyOf(item(), [ev(1, "add", T0, { text: "Wire the drawer" })]);
    expect(h.moments.map((m) => m.kind)).toEqual(["planned"]);
    expect(h.doneIn).toBeUndefined();
    expect(h.reopened).toBe(0);
    expect(h.attemptStartedAt).toBe(T0);
  });

  it("a completed step measures its span from the add", () => {
    const h = historyOf(item({ done: true, updated_at: T0 + 34_000 }), [
      ev(1, "add", T0),
      ev(2, "complete", T0 + 34_000, { done: true }),
    ]);
    expect(h.doneIn).toBe(34_000);
    expect(h.moments[h.moments.length - 1]).toMatchObject({ kind: "done", span: 34_000 });
  });

  it("a reworded step keeps the earlier wording — that is the self-reflection", () => {
    const h = historyOf(item({ text: "Wire the drawer" }), [
      ev(1, "add", T0, { text: "Add drawer" }),
      ev(2, "edit", T0 + 5_000, { text: "Wire the drawer", previous_text: "Add drawer" }),
    ]);
    expect(h.moments[1]).toMatchObject({ kind: "reworded", was: "Add drawer" });
  });

  it("reopening restarts the clock and counts a try", () => {
    const h = historyOf(item({ done: true, updated_at: T0 + 60_000 }), [
      ev(1, "add", T0),
      ev(2, "complete", T0 + 10_000, { done: true }),
      ev(3, "uncomplete", T0 + 20_000, { done: false }),
      ev(4, "complete", T0 + 60_000, { done: true }),
    ]);
    expect(h.reopened).toBe(1);
    expect(h.attemptStartedAt).toBe(T0 + 20_000);
    expect(h.doneIn).toBe(40_000);
    expect(h.moments.map((m) => m.kind)).toEqual(["planned", "done", "reopened", "done"]);
  });

  it("an open step that was once done has no span, even if the log says so", () => {
    const h = historyOf(item({ done: false }), [
      ev(1, "add", T0),
      ev(2, "complete", T0 + 10_000, { done: true }),
      ev(3, "uncomplete", T0 + 20_000, { done: false }),
    ]);
    expect(h.doneIn).toBeUndefined();
  });

  it("ignores other tasks' events", () => {
    const h = historyOf(item(), [ev(1, "add", T0), ev(2, "complete", T0 + 1, { todo_id: "T2", done: true })]);
    expect(h.moments.map((m) => m.kind)).toEqual(["planned"]);
  });

  it("an item without events still opens to a planned line, and trusts the list for done", () => {
    const h = historyOf(item({ done: true, created_at: T0, updated_at: T0 + 8_000 }), []);
    expect(h.moments.map((m) => m.kind)).toEqual(["planned", "done"]);
    expect(h.doneIn).toBe(8_000);
  });
});

describe("work floors", () => {
  // A plan written at T0: step 1 closes at +18s, step 2 at +72s, step 3 open.
  const plan = [
    item({ id: "T1", done: true, updated_at: T0 + 18_000 }),
    item({ id: "T2", done: true, updated_at: T0 + 72_000 }),
    item({ id: "T3" }),
  ];
  const log = [
    ev(1, "add", T0, { todo_id: "T1" }),
    ev(2, "add", T0, { todo_id: "T2" }),
    ev(3, "add", T0, { todo_id: "T3" }),
    ev(4, "complete", T0 + 18_000, { todo_id: "T1", done: true }),
    ev(5, "complete", T0 + 72_000, { todo_id: "T2", done: true }),
  ];

  it("each step may start once the step before it closed", () => {
    expect(workFloors(plan, log)).toEqual([0, T0 + 18_000, T0 + 72_000]);
  });

  it("a span measures the work on the step, not the age of the plan", () => {
    const floors = workFloors(plan, log);
    expect(historyOf(plan[1], log, floors[1]).doneIn).toBe(54_000);
    expect(historyOf(plan[2], log, floors[2]).attemptStartedAt).toBe(T0 + 72_000);
    // the planned line still says when the step was written down
    expect(historyOf(plan[1], log, floors[1]).moments[0]).toMatchObject({ kind: "planned", at: T0 });
  });

  it("a reopen after the floor still restarts the clock", () => {
    const h = historyOf(item({ id: "T2", done: true, updated_at: T0 + 90_000 }), [
      ev(1, "add", T0, { todo_id: "T2" }),
      ev(2, "complete", T0 + 40_000, { todo_id: "T2", done: true }),
      ev(3, "uncomplete", T0 + 60_000, { todo_id: "T2", done: false }),
      ev(4, "complete", T0 + 90_000, { todo_id: "T2", done: true }),
    ], T0 + 18_000);
    expect(h.attemptStartedAt).toBe(T0 + 60_000);
    expect(h.doneIn).toBe(30_000);
    expect(h.moments[1]).toMatchObject({ kind: "done", span: 22_000 });
  });
});

describe("planStartedAt", () => {
  it("is the earliest item or event", () => {
    expect(planStartedAt([item({ created_at: T0 + 5 })], [ev(1, "add", T0 + 2)])).toBe(T0 + 2);
  });
  it("is zero for an empty plan", () => {
    expect(planStartedAt([], [])).toBe(0);
  });
});

describe("formatOffset", () => {
  it("counts seconds, then minutes", () => {
    expect(formatOffset(0)).toBe("+0s");
    expect(formatOffset(12_400)).toBe("+12s");
    expect(formatOffset(64_000)).toBe("+1m 4s");
    expect(formatOffset(120_000)).toBe("+2m");
  });
});

describe("attemptLabel", () => {
  it("is silent for a first try and ordinal after", () => {
    expect(attemptLabel(0)).toBeNull();
    expect(attemptLabel(1)).toBe("2nd try");
    expect(attemptLabel(2)).toBe("3rd try");
    expect(attemptLabel(3)).toBe("4th try");
  });
});

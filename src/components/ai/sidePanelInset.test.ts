import { describe, expect, it } from "vitest";
import { sidePanelInset } from "./sidePanelInset";

const state = { hidden: false, planVisible: false, questionVisible: false, resultVisible: true, width: 320 };

describe("space beside the conversation", () => {
  it("keeps full-width collapsed cards inside the open panel", () => {
    expect(sidePanelInset(state)).toBe(356);
  });
  it("only releases the panel width when the global close folds it", () => {
    expect(sidePanelInset(state)).toBe(356);
    expect(sidePanelInset({ ...state, hidden: true })).toBe(76);
  });
  it("keeps room for a plan or waiting question", () => {
    expect(sidePanelInset({ ...state, planVisible: true })).toBe(356);
    expect(sidePanelInset({ ...state, hidden: true, questionVisible: true })).toBe(356);
  });
  it("ignores an expanded result once hidden or dismissed", () => {
    expect(sidePanelInset({ ...state, hidden: true })).toBe(76);
    expect(sidePanelInset({ ...state, resultVisible: false })).toBe(0);
  });
});

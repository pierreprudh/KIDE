import { describe, expect, it } from "vitest";
import { AUTONOMY_RUNGS, currentRungIndex, effectiveMode } from "./autonomyLadder";

describe("the autonomy ladder", () => {
  it("offers each Mode capability tier exactly once, plus the two Goal policies", () => {
    expect(AUTONOMY_RUNGS.map((r) => r.mode)).toEqual(["chat", "plan", "goal", "goal"]);
    // Only goal distinguishes a review policy — chat and plan never propose an
    // edit, so `review` is not applicable rather than false.
    expect(AUTONOMY_RUNGS.filter((r) => r.review === null).map((r) => r.mode)).toEqual([
      "chat",
      "plan",
    ]);
    expect(AUTONOMY_RUNGS.filter((r) => r.mode === "goal").map((r) => r.review)).toEqual([
      true,
      false,
    ]);
  });

  it("gives every rung a unique key and a label", () => {
    const keys = AUTONOMY_RUNGS.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const r of AUTONOMY_RUNGS) {
      expect(r.label).toBeTruthy();
      expect(r.description).toBeTruthy();
    }
  });
});

describe("currentRungIndex", () => {
  it("lights the rung matching the mode and its review policy", () => {
    expect(currentRungIndex("chat", true)).toBe(0);
    expect(currentRungIndex("plan", false)).toBe(1);
    expect(currentRungIndex("goal", true)).toBe(2);
    expect(currentRungIndex("goal", false)).toBe(3);
  });

  it("ignores the review policy for modes that cannot propose an edit", () => {
    expect(currentRungIndex("chat", false)).toBe(currentRungIndex("chat", true));
    expect(currentRungIndex("plan", false)).toBe(currentRungIndex("plan", true));
  });
});

describe("effectiveMode", () => {
  it("collapses Goal to Chat when the model cannot call tools", () => {
    // Otherwise the run silently does nothing.
    expect(
      effectiveMode({ mode: "goal", modelSupportsTools: false, providerDelegatesWork: false })
    ).toBe("chat");
  });

  it("keeps Goal for a delegate, whose CLI runs its own tools", () => {
    // The clause FocusMode's copy of this rule was missing. Klide's view of
    // "does this model support tools" does not apply to a delegate.
    expect(
      effectiveMode({ mode: "goal", modelSupportsTools: false, providerDelegatesWork: true })
    ).toBe("goal");
  });

  it("leaves the non-tool modes alone", () => {
    for (const mode of ["chat", "plan"] as const) {
      expect(effectiveMode({ mode, modelSupportsTools: false, providerDelegatesWork: false })).toBe(
        mode
      );
    }
  });

  it("is a no-op when the model does support tools", () => {
    expect(
      effectiveMode({ mode: "goal", modelSupportsTools: true, providerDelegatesWork: false })
    ).toBe("goal");
  });
});

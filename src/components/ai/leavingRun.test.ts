import { describe, expect, it } from "vitest";
import { decideOnLeavingRun } from "./leavingRun";

describe("leaving a conversation with a run in it", () => {
  it("leaves a working run alone", () => {
    // The regression this whole rule exists for: clicking a sibling thread in
    // the rail used to kill the agent working in the one you left.
    expect(decideOnLeavingRun({ hasActiveRun: true, parkedOnDecision: false })).toEqual({
      abort: false,
      settle: false,
    });
  });

  it("keeps a surviving run on the board, so its rail row keeps animating", () => {
    expect(decideOnLeavingRun({ hasActiveRun: true, parkedOnDecision: false }).settle).toBe(false);
  });

  it("aborts a run parked on a decision — nothing replays the card", () => {
    expect(decideOnLeavingRun({ hasActiveRun: true, parkedOnDecision: true })).toEqual({
      abort: true,
      settle: true,
    });
  });

  it("settles a conversation with no run rather than leaving a stale row", () => {
    expect(decideOnLeavingRun({ hasActiveRun: false, parkedOnDecision: false })).toEqual({
      abort: false,
      settle: true,
    });
  });

  it("has nothing to abort when there is no run, whatever a stale card says", () => {
    expect(decideOnLeavingRun({ hasActiveRun: false, parkedOnDecision: true }).abort).toBe(false);
  });
});

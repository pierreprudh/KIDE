import { describe, expect, it } from "vitest";
import { decideOnLeavingRun, shouldReadoptConversation } from "./leavingRun";

describe("leaving a conversation with a run in it", () => {
  it("leaves a working run alone", () => {
    // The regression this whole rule exists for: clicking a sibling thread in
    // the rail used to kill the agent working in the one you left.
    expect(decideOnLeavingRun({ hasActiveRun: true })).toEqual({
      abort: false,
      settle: false,
    });
  });

  it("keeps a surviving run on the board, so its rail row keeps animating", () => {
    expect(decideOnLeavingRun({ hasActiveRun: true }).settle).toBe(false);
  });

  it("settles a conversation with no run rather than leaving a stale row", () => {
    expect(decideOnLeavingRun({ hasActiveRun: false })).toEqual({
      abort: false,
      settle: true,
    });
  });
});

describe("arriving at a conversation", () => {
  it("refuses to re-adopt the thread already streaming on screen", () => {
    // The regression this rule exists for: clicking the row of the very
    // conversation you were watching dropped the token-delta channel, and the
    // reattach broadcast only replays structural events — the view went from
    // streaming to frozen-between-tool-calls for a click that changed nothing.
    expect(
      shouldReadoptConversation({ sameConversation: true, followingLiveRun: true }),
    ).toBe(false);
  });

  it("re-adopts the same thread when the panel is no longer following its run", () => {
    // A detached view (walked away and back, or the view fell behind) has a
    // stale transcript on screen; re-adopting is how it catches up.
    expect(
      shouldReadoptConversation({ sameConversation: true, followingLiveRun: false }),
    ).toBe(true);
  });

  it("always adopts a different thread, streaming or not", () => {
    expect(
      shouldReadoptConversation({ sameConversation: false, followingLiveRun: true }),
    ).toBe(true);
    expect(
      shouldReadoptConversation({ sameConversation: false, followingLiveRun: false }),
    ).toBe(true);
  });
});

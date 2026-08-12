import { describe, expect, it } from "vitest";
import type { Conversation } from "../components/ai/types";
import type { PendingAiPanel } from "../components/ai/panelHost";
import {
  aiPanelFleetReducer,
  initialAiPanelFleetState,
  type AiPanelFleetState,
} from "./useAiPanelFleet";

const convo = (id: string): Conversation => ({
  id,
  title: id,
  msgs: [],
  updatedAt: 1,
});

const handoff = (panelId: string): PendingAiPanel => ({
  panelId,
  provider: "codex",
  resumeSessionId: null,
  initialTask: null,
  conversationId: null,
});

function reduce(state: AiPanelFleetState, action: Parameters<typeof aiPanelFleetReducer>[1]) {
  return aiPanelFleetReducer(state, action);
}

/** Several actions in order — the continuation cases are all about sequence. */
function reduceAll(
  state: AiPanelFleetState,
  ...actions: Parameters<typeof aiPanelFleetReducer>[1][]
): AiPanelFleetState {
  return actions.reduce(aiPanelFleetReducer, state);
}

describe("AI panel fleet reducer", () => {
  it("merges simultaneous handoffs instead of clobbering an unconsumed panel", () => {
    const first = reduce(initialAiPanelFleetState, {
      type: "handoffs-queued",
      handoffs: [handoff("ai-1")],
    });
    const second = reduce(first, {
      type: "handoffs-queued",
      handoffs: [handoff("ai-2")],
    });

    expect(Object.keys(second.pendingByPanel)).toEqual(["ai-1", "ai-2"]);
  });

  it("only lets the targeted panel consume a resume", () => {
    const targeted = reduce(initialAiPanelFleetState, {
      type: "resume-targeted",
      panelId: "ai-2",
      convo: convo("run-1"),
    });

    expect(
      reduce(targeted, { type: "resume-consumed", panelId: "ai-1" }).resumeTarget,
    ).not.toBeNull();
    expect(
      reduce(targeted, { type: "resume-consumed", panelId: "ai-2" }).resumeTarget,
    ).toBeNull();
  });

  it("fans one follow-up out to every watched racer", () => {
    const watching = reduce(initialAiPanelFleetState, {
      type: "race-watch-started",
      handoffs: [handoff("ai-a"), handoff("ai-b")],
      tabs: [
        { panelId: "ai-a", label: "A" },
        { panelId: "ai-b", label: "B" },
      ],
      focusActiveTabId: "ai-a",
    });
    const queued = reduce(watching, {
      type: "race-follow-up-queued",
      text: "  compare tests  ",
      nonce: 42,
    });

    expect(queued.followUpsByPanel).toEqual({
      "ai-a": { text: "compare tests", nonce: 42 },
      "ai-b": { text: "compare tests", nonce: 42 },
    });
  });

  it("closes every queue for a panel and advances the active race tab atomically", () => {
    const state: AiPanelFleetState = {
      pendingByPanel: { "ai-a": handoff("ai-a"), "ai-b": handoff("ai-b") },
      resumeTarget: { panelId: "ai-a", convo: convo("run-1") },
      raceWatchTabs: [
        { panelId: "ai-a", label: "A" },
        { panelId: "ai-b", label: "B" },
      ],
      focusActiveTabId: "ai-a",
      followUpsByPanel: {
        "ai-a": { text: "test", nonce: 1 },
        "ai-b": { text: "test", nonce: 1 },
      },
      pendingContinuation: null,
    };

    const closed = reduce(state, { type: "panel-closed", panelId: "ai-a" });

    expect(closed.pendingByPanel["ai-a"]).toBeUndefined();
    expect(closed.resumeTarget).toBeNull();
    expect(closed.raceWatchTabs).toEqual([{ panelId: "ai-b", label: "B" }]);
    expect(closed.focusActiveTabId).toBe("ai-b");
    expect(closed.followUpsByPanel["ai-a"]).toBeUndefined();
  });
});

describe("resuming a conversation with a continuation", () => {
  it("holds the text back until the panel has loaded the conversation", () => {
    const armed = reduce(initialAiPanelFleetState, {
      type: "resume-targeted",
      panelId: "ai-main",
      convo: convo("c1"),
      continueWith: { text: "and now the other half", nonce: 7 },
    });

    // The whole point: nothing is sendable yet. Handing the panel a follow-up
    // in this same pass would put the turn in the outgoing conversation.
    expect(armed.followUpsByPanel).toEqual({});
    expect(armed.resumeTarget?.convo.id).toBe("c1");
    expect(armed.pendingContinuation).toEqual({
      panelId: "ai-main",
      text: "and now the other half",
      nonce: 7,
    });

    const released = reduce(armed, { type: "resume-consumed", panelId: "ai-main" });

    expect(released.resumeTarget).toBeNull();
    expect(released.pendingContinuation).toBeNull();
    expect(released.followUpsByPanel).toEqual({
      "ai-main": { text: "and now the other half", nonce: 7 },
    });
  });

  it("leaves a plain resume with nothing to send", () => {
    const state = reduceAll(
      initialAiPanelFleetState,
      { type: "resume-targeted", panelId: "ai-main", convo: convo("c1") },
      { type: "resume-consumed", panelId: "ai-main" },
    );

    expect(state.followUpsByPanel).toEqual({});
    expect(state.pendingContinuation).toBeNull();
  });

  it("drops a continuation whose panel closes before the resume lands", () => {
    const state = reduceAll(
      initialAiPanelFleetState,
      {
        type: "resume-targeted",
        panelId: "ai-main",
        convo: convo("c1"),
        continueWith: { text: "never sent", nonce: 7 },
      },
      { type: "panel-closed", panelId: "ai-main" },
      // A late consume from the unmounting panel must not resurrect the turn.
      { type: "resume-consumed", panelId: "ai-main" },
    );

    expect(state.pendingContinuation).toBeNull();
    expect(state.followUpsByPanel).toEqual({});
  });

  it("re-targeting the reader clears a continuation that never landed", () => {
    const state = reduceAll(
      initialAiPanelFleetState,
      {
        type: "resume-targeted",
        panelId: "ai-main",
        convo: convo("c1"),
        continueWith: { text: "abandoned", nonce: 7 },
      },
      // Opened a different conversation instead, with no text this time.
      { type: "resume-targeted", panelId: "ai-main", convo: convo("c2") },
      { type: "resume-consumed", panelId: "ai-main" },
    );

    expect(state.followUpsByPanel).toEqual({});
  });

  it("keeps a race fan-out independent of a parked continuation", () => {
    const state = reduceAll(
      initialAiPanelFleetState,
      {
        type: "race-watch-started",
        handoffs: [],
        tabs: [
          { panelId: "ai-a", label: "A" },
          { panelId: "ai-b", label: "B" },
        ],
        focusActiveTabId: "ai-a",
      },
      {
        type: "resume-targeted",
        panelId: "ai-main",
        convo: convo("c1"),
        continueWith: { text: "continue", nonce: 7 },
      },
      { type: "race-follow-up-queued", text: "ask both", nonce: 9 },
    );

    expect(state.followUpsByPanel).toEqual({
      "ai-a": { text: "ask both", nonce: 9 },
      "ai-b": { text: "ask both", nonce: 9 },
    });
    expect(state.pendingContinuation?.text).toBe("continue");
  });
});

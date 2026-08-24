import { describe, expect, it } from "vitest";
import {
  eventsToConversation,
  eventsToMsgs,
  isSilentRunError,
  replayForAdoption,
  shouldHealFromTranscript,
} from "./replayConversation";
import type { AgentEvent } from "../../agent/types";
import type { Msg } from "./types";

// No `as AgentEvent` anywhere below: the union is the contract, and an
// unchecked cast is how a fixture ends up describing a wire shape Rust never
// emits. `usage` and `timing` are `skip_serializing_if = "Option::is_none"` on
// the Rust side, so they are *absent* rather than null — writing `null` here
// (and casting past the error) produced a crash that looked like a bug in
// `foldAgentEvents` and was a bug in the fixture.

function runStarted(ts: number): AgentEvent {
  return {
    type: "run_started",
    runId: "r1",
    mode: "goal",
    provider: "anthropic",
    model: "claude-sonnet-4-6",
    cwd: null,
    ts,
  };
}

function userMessage(text: string, ts: number): AgentEvent {
  return { type: "user_message", runId: "r1", messageId: "u1", text, attachments: [], ts };
}

function assistantMessage(text: string, ts: number): AgentEvent {
  return {
    type: "assistant_message",
    runId: "r1",
    messageId: "a1",
    content: [{ type: "text", text }],
    ts,
  };
}

type RunErrorCode = Extract<AgentEvent, { type: "run_error" }>["error"]["code"];

function runError(code: RunErrorCode, message: string, ts: number): AgentEvent {
  return {
    type: "run_error",
    runId: "r1",
    error: { code, message, retryable: false },
    ts,
  };
}

describe("eventsToConversation", () => {
  it("prepends a system line naming the run's mode, provider and model", () => {
    const convo = eventsToConversation(
      [runStarted(1_000), userMessage("hi", 1_100), assistantMessage("hello", 1_200)],
      "r1",
      "Fix the tests"
    );
    expect(convo.msgs[0]).toEqual({
      role: "system",
      content: "Run: goal · anthropic/claude-sonnet-4-6",
    });
    expect(convo.id).toBe("r1");
    expect(convo.title).toBe("Fix the tests");
  });

  it("takes both timestamps from the transcript, never from the clock", () => {
    // A run that finished days ago must not be stamped "now" — the board sorts
    // and the panel dates conversations off these.
    const convo = eventsToConversation(
      [runStarted(1_000), userMessage("hi", 1_100), assistantMessage("done", 9_999)],
      "r1",
      "t"
    );
    expect(convo.createdAt).toBe(1_000);
    expect(convo.updatedAt).toBe(9_999);
  });

  it("explains a failed run instead of replaying as empty", () => {
    // A provider 500 leaves no assistant turn to fold, so without this line a
    // resumed panel shows the user's message and nothing else — reading as an
    // empty or hung run.
    const convo = eventsToConversation(
      [runStarted(1), userMessage("hi", 2), runError("provider_unavailable", "502 from upstream", 3)],
      "r1",
      "t"
    );
    const last = convo.msgs[convo.msgs.length - 1];
    expect(last).toEqual({ role: "system", content: "Run failed: 502 from upstream" });
  });

  it("stays silent about a run the user stopped", () => {
    // A Stop is not a failure; the partial output is the answer. This must match
    // the live path in AiPanel, which is why the rule is shared.
    const convo = eventsToConversation(
      [runStarted(1), userMessage("hi", 2), assistantMessage("partial", 3), runError("aborted", "Aborted", 4)],
      "r1",
      "t"
    );
    expect(convo.msgs.some((m) => m.content.startsWith("Run failed:"))).toBe(false);
    expect(isSilentRunError("aborted")).toBe(true);
    expect(isSilentRunError("provider_unavailable")).toBe(false);
  });

  it("survives a transcript with no events", () => {
    const convo = eventsToConversation([], "r1", "t");
    expect(convo.msgs).toEqual([]);
    expect(convo.createdAt).toBeUndefined();
    expect(typeof convo.updatedAt).toBe("number");
  });

  it("omits the header when the transcript does not start with run_started", () => {
    // A truncated or hand-edited transcript should replay what it has rather
    // than assert metadata it never recorded.
    const convo = eventsToConversation([userMessage("hi", 1)], "r1", "t");
    expect(convo.msgs[0].role).toBe("user");
  });
});

describe("eventsToMsgs", () => {
  it("folds a transcript into the panel's messages", () => {
    const msgs = eventsToMsgs([runStarted(1), userMessage("hi", 2), assistantMessage("hello", 3)]);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(msgs[1].content).toBe("hello");
  });

  it("is empty for an empty transcript", () => {
    expect(eventsToMsgs([])).toEqual([]);
  });
});

describe("replayForAdoption", () => {
  const transcript = [runStarted(1), userMessage("hi", 2), assistantMessage("hello", 3)];

  it("heals a view that stopped short of what the run wrote", () => {
    // The case this exists for: the panel took the user turn and the start of
    // the answer, then stopped following the run. The Transcript has the whole
    // exchange, so adopting it puts the answer back on screen.
    const onScreen: Msg[] = [{ role: "user", content: "hi" }];
    const healed = replayForAdoption(transcript, onScreen);
    expect(healed?.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(healed?.[1].content).toBe("hello");
  });

  it("carries queued turns across the replay", () => {
    // A turn typed ahead has not been sent, so the Transcript cannot know about
    // it. Dropping it here would silently swallow what the user just wrote.
    const queued: Msg = { role: "user", content: "and then?", queueState: "queued" };
    const healed = replayForAdoption(transcript, [{ role: "user", content: "hi" }, queued]);
    expect(healed?.[healed.length - 1]).toBe(queued);
  });

  it("refuses a replay shorter than what is already on screen", () => {
    // A half-written or truncated read must never eat live rows.
    const onScreen: Msg[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      { role: "assistant", content: "and more" },
    ];
    expect(replayForAdoption(transcript, onScreen)).toBeNull();
    expect(replayForAdoption([], onScreen)).toBeNull();
  });
});

describe("shouldHealFromTranscript", () => {
  const healthy = {
    behind: null,
    stillOnConversation: true,
    subagent: false,
    delegateWithoutTranscript: false,
  } as const;

  it("leaves a turn that reached the screen alone", () => {
    expect(shouldHealFromTranscript(healthy)).toBe(false);
  });

  it("heals a turn whose region was taken over mid-run", () => {
    expect(shouldHealFromTranscript({ ...healthy, behind: "region-detached" })).toBe(true);
  });

  it("heals a turn whose generation was retired under it", () => {
    // The regression this exists for. The panel used to also require the turn
    // generation to still be current — but a generation is only ever bumped, so
    // the one case this branch was written for could never satisfy it. Stop,
    // pressed mid-run, is exactly that: the generation moves on, the
    // conversation does not, and the answer already written stays on disk.
    expect(shouldHealFromTranscript({ ...healthy, behind: "generation-retired" })).toBe(true);
  });

  it("does not heal a conversation the panel has left", () => {
    // Leaving, a new chat and resuming another thread all change the
    // conversation — adopting this Run's replay would land it on someone else's
    // thread, which is a worse bug than the short view.
    expect(
      shouldHealFromTranscript({
        ...healthy,
        behind: "generation-retired",
        stillOnConversation: false,
      }),
    ).toBe(false);
  });

  it("does not heal a subagent turn or a Delegate without a transcript", () => {
    expect(
      shouldHealFromTranscript({ ...healthy, behind: "region-detached", subagent: true }),
    ).toBe(false);
    expect(
      shouldHealFromTranscript({
        ...healthy,
        behind: "region-detached",
        delegateWithoutTranscript: true,
      }),
    ).toBe(false);
  });
});

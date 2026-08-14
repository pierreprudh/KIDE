import { describe, expect, it } from "vitest";
import { createRunTranscript, type RunTranscript } from "./transcriptReducer";
import type { Msg } from "./types";
import type { AgentContentBlock, AgentEvent, AgentUsage } from "../../agent/types";

// The run transcript is the live Msg[] view of one run's fold: it owns the
// run's region of the panel array, re-projects only the rows an event
// touched, and detaches rather than clobber a region it no longer owns. The
// event → row logic itself is foldEvents.ts's — tested there.
//
// No `as AgentEvent` anywhere below: the union is the contract, and an
// unchecked cast is how a fixture ends up describing a wire shape Rust never
// emits.

let ts = 0;
const at = () => (ts += 10);

function delta(text: string, thinking?: string): AgentEvent {
  return { type: "assistant_delta", runId: "r", messageId: `d-${ts}`, text, thinking, ts: at() };
}

function message(content: AgentContentBlock[], usage?: AgentUsage): AgentEvent {
  return { type: "assistant_message", runId: "r", messageId: `m-${ts}`, content, usage, ts: at() };
}

function text(t: string): AgentContentBlock[] {
  return [{ type: "text", text: t }];
}

function toolStarted(toolCallId: string, name: string): AgentEvent {
  return { type: "tool_call_started", runId: "r", toolCallId, name, input: {}, summary: name, ts: at() };
}

function toolFinished(toolCallId: string, content: string): AgentEvent {
  return { type: "tool_call_finished", runId: "r", toolCallId, result: { ok: true, content }, ts: at() };
}

function steered(reason: string): AgentEvent {
  return { type: "steering_injected", runId: "r", reason, ts: at() };
}

/** A tiny stand-in for the panel: an array cell plus apply-then-project. */
function panel(initial: Msg[], regionStart = initial.length - 1) {
  const seedCandidate = initial[regionStart];
  const transcript: RunTranscript = createRunTranscript({
    regionStart,
    seed: seedCandidate?.role === "assistant" ? seedCandidate : null,
    delegate: {},
    pricing: null,
  });
  const state = { msgs: initial };
  const feed = (...events: AgentEvent[]) => {
    for (const event of events) transcript.apply(event);
    const next = transcript.project(state.msgs);
    if (next) state.msgs = next;
    return next;
  };
  return { transcript, state, feed };
}

const placeholder = (): Msg => ({ role: "assistant", content: "" });

describe("createRunTranscript", () => {
  it("adopts the placeholder bubble: nothing to project until the stream writes", () => {
    const seed = placeholder();
    const p = panel([{ role: "user", content: "q" }, seed]);
    expect(p.transcript.project(p.state.msgs)).toBeNull();
    expect(p.state.msgs[1]).toBe(seed); // same reference, untouched
  });

  it("keeps streamed content when the final message text is empty", () => {
    const p = panel([placeholder()]);
    p.feed(delta("streamed so far"), message(text("")));
    expect(p.state.msgs[0]).toMatchObject({ role: "assistant", content: "streamed so far" });
  });

  it("does not mutate the array it projects from", () => {
    const before: Msg[] = [placeholder()];
    const p = panel(before);
    p.feed(delta("b"));
    expect(before).toHaveLength(1);
    expect(before[0]).toEqual({ role: "assistant", content: "" });
  });

  it("inserts a Running row per started call and replaces the right one on finish", () => {
    const p = panel([placeholder()]);
    p.feed(message(text("calling")), toolStarted("x", "a"), toolStarted("y", "b"));
    expect(p.state.msgs[1]).toMatchObject({ role: "tool", content: "Running a...", toolCallId: "x" });
    expect(p.state.msgs[2]).toMatchObject({ role: "tool", content: "Running b...", toolCallId: "y" });
    p.feed(toolFinished("y", "b result"));
    expect(p.state.msgs[2]).toMatchObject({ role: "tool", content: "b result", toolName: "b" });
    expect(p.state.msgs[1]).toMatchObject({ content: "Running a..." }); // untouched
  });

  it("lands the next turn's answer in a fresh bubble under the tool card", () => {
    // The regression the old cursor walk pinned: after a tool card, the
    // follow-up text must not be dropped or merged into the finished turn.
    const p = panel([{ role: "user", content: "q" }, placeholder()]);
    p.feed(message(text("calling tools")), toolStarted("c1", "grep"), toolFinished("c1", "3 matches"));
    p.feed(delta("final answer"));
    expect(p.state.msgs[2]).toMatchObject({ role: "tool", content: "3 matches" });
    expect(p.state.msgs[3]).toMatchObject({ role: "assistant", content: "final answer" });
  });

  it("splices a steering marker into the flow, next bubble below it", () => {
    const p = panel([placeholder()]);
    p.feed(message(text("looping")), steered("try a different tool"), delta("recovered"));
    expect(p.state.msgs.map((m) => m.role)).toEqual(["assistant", "system", "assistant"]);
    expect(p.state.msgs[1]).toMatchObject({ role: "system", steering: { reason: "try a different tool" } });
    expect(p.state.msgs[2]).toMatchObject({ role: "assistant", content: "recovered" });
  });

  it("keeps untouched rows' Msg references stable across projections", () => {
    const p = panel([{ role: "user", content: "q" }, placeholder()]);
    p.feed(message(text("turn one")), toolStarted("c1", "grep"), toolFinished("c1", "ok"));
    const [user, turnOne, toolRow] = p.state.msgs;
    p.feed(delta("turn "), delta("two streaming"));
    // Only the new bubble is a new object; everything already rendered keeps
    // its identity, so React re-renders one row per flush, not the list.
    expect(p.state.msgs[0]).toBe(user);
    expect(p.state.msgs[1]).toBe(turnOne);
    expect(p.state.msgs[2]).toBe(toolRow);
    expect(p.state.msgs[3]).toMatchObject({ role: "assistant", content: "turn two streaming" });
  });

  it("preserves the prefix and panel-appended suffix around the region", () => {
    const p = panel([{ role: "user", content: "q" }, placeholder()]);
    p.feed(message(text("working")));
    // The panel appends rows it owns while the run streams (queued turns,
    // compaction markers). They live after the region and must stay there.
    const queued: Msg = { role: "user", content: "follow-up", queueState: "queued" };
    p.state.msgs = [...p.state.msgs, queued];
    p.feed(toolStarted("c1", "bash"), delta("more"));
    const roles = p.state.msgs.map((m) => m.role);
    expect(roles).toEqual(["user", "assistant", "tool", "assistant", "user"]);
    expect(p.state.msgs[p.state.msgs.length - 1]).toBe(queued);
  });

  it("detaches instead of clobbering a region someone else rewrote", () => {
    // The panel's error path replaces the bubble with a failure message; a
    // late flush must not resurrect the partial stream over it.
    const p = panel([placeholder()]);
    p.feed(delta("partial"));
    p.state.msgs = [{ role: "assistant", content: "⚠ provider unavailable" }];
    p.transcript.apply(delta(" more"));
    expect(p.transcript.project(p.state.msgs)).toBeNull();
    expect(p.state.msgs[0]).toMatchObject({ content: "⚠ provider unavailable" });
  });

  it("assistantIndex points at the current turn's bubble", () => {
    const p = panel([{ role: "user", content: "q" }, placeholder()]);
    expect(p.transcript.assistantIndex()).toBe(1); // the placeholder
    p.feed(message(text("one")), toolStarted("c1", "grep"), delta("two"));
    expect(p.transcript.assistantIndex()).toBe(3); // past bubble one + its tool card
    expect(p.state.msgs[3]).toMatchObject({ role: "assistant", content: "two" });
  });
});

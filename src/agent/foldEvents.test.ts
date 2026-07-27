import { describe, expect, it } from "vitest";
import { foldAgentEvents, foldedToMsgs, foldedToRunMessages } from "./foldEvents";
import type { AgentAttachment, AgentContentBlock, AgentEvent, AgentUsage } from "./types";
import type { Msg } from "../components/ai/types";

// `foldAgentEvents` is the one place the AgentEvent wire format is turned into a
// conversation, and both renderers sit on it: the AI panel through
// `foldedToMsgs` (replay + fork) and Mission Control through
// `foldedToRunMessages` (every Klide run row). It had no tests.

const RUN = "run-1";
let ts = 1_000;
const at = () => (ts += 100);

function userMessage(text: string, attachments: AgentAttachment[] = []): AgentEvent {
  return {
    type: "user_message",
    runId: RUN,
    messageId: `u-${ts}`,
    text,
    attachments,
    ts: at(),
  };
}

function assistantMessage(
  text: string,
  opts: {
    thinking?: string;
    toolCalls?: { toolCallId: string; name: string; input?: unknown }[];
    usage?: AgentUsage;
  } = {},
): AgentEvent {
  const content: AgentContentBlock[] = [];
  if (opts.thinking) content.push({ type: "thinking", text: opts.thinking });
  if (text) content.push({ type: "text", text });
  for (const call of opts.toolCalls ?? []) {
    content.push({
      type: "tool_call",
      toolCallId: call.toolCallId,
      name: call.name,
      input: call.input,
    });
  }
  return {
    type: "assistant_message",
    runId: RUN,
    messageId: `a-${ts}`,
    content,
    usage: opts.usage,
    ts: at(),
  };
}

function toolStarted(toolCallId: string, name: string, input?: unknown): AgentEvent {
  return {
    type: "tool_call_started",
    runId: RUN,
    toolCallId,
    name,
    input,
    summary: `${name} …`,
    ts: at(),
  };
}

function toolFinished(toolCallId: string, content: string, ok = true): AgentEvent {
  return {
    type: "tool_call_finished",
    runId: RUN,
    toolCallId,
    result: { ok, content },
    ts: at(),
  };
}

function compacted(summary: string): AgentEvent {
  return { type: "context_compacted", runId: RUN, summary, ts: at() };
}

describe("foldAgentEvents", () => {
  it("pairs user and assistant turns in order", () => {
    const rows = foldAgentEvents([
      userMessage("hello"),
      assistantMessage("hi there"),
      userMessage("again"),
      assistantMessage("still here"),
    ]);
    expect(rows.map((r) => r.kind)).toEqual(["user", "assistant", "user", "assistant"]);
    expect(rows[0]).toMatchObject({ kind: "user", text: "hello" });
    expect(rows[1]).toMatchObject({ kind: "assistant", text: "hi there" });
  });

  it("ignores events it does not model, like run_started and context_snapshot", () => {
    const rows = foldAgentEvents([
      { type: "run_started", runId: RUN, cwd: null, mode: "goal", provider: "ollama", model: "m", ts: at() },
      userMessage("go"),
      assistantMessage("done"),
    ]);
    expect(rows).toHaveLength(2);
  });

  it("joins multiple text blocks and lifts thinking out of the content array", () => {
    const rows = foldAgentEvents([
      assistantMessage("", { thinking: "let me think" }),
    ]);
    expect(rows[0]).toMatchObject({ kind: "assistant", text: "", thinking: "let me think" });
  });

  describe("tool-call lifecycle correlation", () => {
    it("correlates a started/finished pair onto the assistant that declared it", () => {
      const rows = foldAgentEvents([
        userMessage("read it"),
        assistantMessage("reading", { toolCalls: [{ toolCallId: "t1", name: "read_file", input: { path: "a.ts" } }] }),
        toolStarted("t1", "read_file", { path: "a.ts" }),
        toolFinished("t1", "file body"),
      ]);
      const assistant = rows[1];
      if (assistant.kind !== "assistant") throw new Error("expected assistant");
      expect(assistant.toolCalls).toHaveLength(1);
      expect(assistant.toolCalls[0]).toMatchObject({
        id: "t1",
        name: "read_file",
        status: "finished",
        result: { content: "file body", ok: true },
      });
    });

    it("attaches a result to a NON-final assistant row", () => {
      // The reason findTool walks every assistant row rather than just the last:
      // a tool result can land after the model has already produced more text.
      const rows = foldAgentEvents([
        assistantMessage("first, a tool", { toolCalls: [{ toolCallId: "t1", name: "grep" }] }),
        assistantMessage("and some follow-up prose"),
        toolFinished("t1", "3 matches"),
      ]);
      const first = rows[0];
      if (first.kind !== "assistant") throw new Error("expected assistant");
      expect(first.toolCalls[0]).toMatchObject({ id: "t1", status: "finished" });
      const second = rows[1];
      if (second.kind !== "assistant") throw new Error("expected assistant");
      expect(second.toolCalls).toHaveLength(0);
    });

    it("synthesises an assistant row for a tool that no assistant declared", () => {
      // Small models sometimes emit tool_call_started with no preceding
      // assistant_message; the fold must not drop the call on the floor.
      const rows = foldAgentEvents([toolStarted("orphan", "list_dir"), toolFinished("orphan", "a\nb")]);
      expect(rows).toHaveLength(1);
      const only = rows[0];
      if (only.kind !== "assistant") throw new Error("expected a synthesised assistant");
      expect(only.text).toBe("");
      expect(only.toolCalls[0]).toMatchObject({ id: "orphan", name: "list_dir", status: "finished" });
    });

    it("records a still-running call as started and an undeclared finish as finished", () => {
      const rows = foldAgentEvents([
        assistantMessage("working", { toolCalls: [{ toolCallId: "t1", name: "bash" }] }),
        toolStarted("t1", "bash"),
      ]);
      const row = rows[0];
      if (row.kind !== "assistant") throw new Error("expected assistant");
      expect(row.toolCalls[0].status).toBe("started");
      expect(row.toolCalls[0].result).toBeUndefined();
    });

    it("keeps a declared-but-never-started call as unknown", () => {
      const rows = foldAgentEvents([
        assistantMessage("planning", { toolCalls: [{ toolCallId: "t9", name: "write_file" }] }),
      ]);
      const row = rows[0];
      if (row.kind !== "assistant") throw new Error("expected assistant");
      expect(row.toolCalls[0].status).toBe("unknown");
    });

    it("carries a failed result's ok flag through", () => {
      const rows = foldAgentEvents([
        assistantMessage("try", { toolCalls: [{ toolCallId: "t1", name: "bash" }] }),
        toolFinished("t1", "command not found", false),
      ]);
      const row = rows[0];
      if (row.kind !== "assistant") throw new Error("expected assistant");
      expect(row.toolCalls[0].result).toEqual({ content: "command not found", ok: false });
    });
  });

  describe("meta: exact provider usage vs estimate", () => {
    it("prefers provider-reported completion tokens and marks them exact", () => {
      const rows = foldAgentEvents([
        userMessage("hi"),
        assistantMessage("a fairly short answer", {
          usage: { completionTokens: 7, evalDurationMs: 1_000, costUsd: 0.0012 },
        }),
      ]);
      const row = rows[1];
      if (row.kind !== "assistant") throw new Error("expected assistant");
      expect(row.meta).toMatchObject({ tokens: 7, exact: true, tps: 7, costUsd: 0.0012 });
      // With real usage there is no estimate to expose.
      expect(row.meta?.tokensEstimate).toBeUndefined();
    });

    it("falls back to a length estimate and marks it inexact", () => {
      const text = "x".repeat(40);
      const rows = foldAgentEvents([userMessage("hi"), assistantMessage(text)]);
      const row = rows[1];
      if (row.kind !== "assistant") throw new Error("expected assistant");
      expect(row.meta).toMatchObject({ tokens: 10, tokensEstimate: 10, exact: false });
      expect(row.meta?.tps).toBeUndefined();
    });

    it("counts thinking text toward the estimate", () => {
      const rows = foldAgentEvents([
        assistantMessage("x".repeat(20), { thinking: "y".repeat(20) }),
      ]);
      const row = rows[0];
      if (row.kind !== "assistant") throw new Error("expected assistant");
      expect(row.meta?.tokens).toBe(10);
    });

    it("omits tps when the provider reports no eval duration", () => {
      const rows = foldAgentEvents([
        assistantMessage("answer", { usage: { completionTokens: 5 } }),
      ]);
      const row = rows[0];
      if (row.kind !== "assistant") throw new Error("expected assistant");
      expect(row.meta?.exact).toBe(true);
      expect(row.meta?.tps).toBeUndefined();
    });

    it("times each turn from its own boundary, not from the run start", () => {
      ts = 0;
      const events: AgentEvent[] = [
        { type: "user_message", runId: RUN, messageId: "u1", text: "one", attachments: [], ts: 1_000 },
        { type: "assistant_message", runId: RUN, messageId: "a1", content: [{ type: "text", text: "first" }], ts: 1_500 },
        { type: "user_message", runId: RUN, messageId: "u2", text: "two", attachments: [], ts: 5_000 },
        { type: "assistant_message", runId: RUN, messageId: "a2", content: [{ type: "text", text: "second" }], ts: 5_250 },
      ];
      const rows = foldAgentEvents(events);
      const first = rows[1];
      const second = rows[3];
      if (first.kind !== "assistant" || second.kind !== "assistant") throw new Error("expected assistants");
      expect(first.meta?.ms).toBe(500);
      // 250, not 4250 — the second turn is timed from the second user message.
      expect(second.meta?.ms).toBe(250);
    });
  });

  describe("context_compacted", () => {
    // Regression: this variant existed in Rust (emitted, persisted to the
    // Transcript, honoured on replay) but had no TypeScript counterpart, so the
    // fold silently dropped it and a reloaded conversation looked like an
    // unbroken thread that had mysteriously forgotten its early turns.
    it("becomes a compaction row carrying the summary and the collapsed count", () => {
      const rows = foldAgentEvents([
        userMessage("one"),
        assistantMessage("first"),
        compacted("Earlier: the user asked about one."),
        userMessage("two"),
        assistantMessage("second"),
      ]);
      expect(rows.map((r) => r.kind)).toEqual([
        "user",
        "assistant",
        "compaction",
        "user",
        "assistant",
      ]);
      expect(rows[2]).toEqual({
        kind: "compaction",
        summary: "Earlier: the user asked about one.",
        count: 2,
      });
    });

    it("does not break tool correlation across the marker", () => {
      const rows = foldAgentEvents([
        assistantMessage("start", { toolCalls: [{ toolCallId: "t1", name: "read_file" }] }),
        compacted("summary"),
        toolFinished("t1", "body"),
      ]);
      const assistant = rows[0];
      if (assistant.kind !== "assistant") throw new Error("expected assistant");
      expect(assistant.toolCalls[0]).toMatchObject({ id: "t1", status: "finished" });
    });

    it("does not reset the turn clock", () => {
      const rows = foldAgentEvents([
        { type: "user_message", runId: RUN, messageId: "u1", text: "one", attachments: [], ts: 1_000 },
        { type: "context_compacted", runId: RUN, summary: "s", ts: 1_200 },
        { type: "assistant_message", runId: RUN, messageId: "a1", content: [{ type: "text", text: "answer" }], ts: 1_800 },
      ]);
      const assistant = rows[2];
      if (assistant.kind !== "assistant") throw new Error("expected assistant");
      expect(assistant.meta?.ms).toBe(800);
    });
  });
});

describe("foldedToMsgs — the AI panel shape", () => {
  it("emits an assistant row plus one tool row per finished call", () => {
    const msgs = foldedToMsgs(
      foldAgentEvents([
        userMessage("read it"),
        assistantMessage("reading", { toolCalls: [{ toolCallId: "t1", name: "read_file", input: { path: "a.ts" } }] }),
        toolFinished("t1", "file body"),
      ]),
    );
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant", "tool"]);
    const assistant = msgs[1] as Extract<Msg, { role: "assistant" }>;
    expect(assistant.toolCalls).toEqual([
      { id: "t1", name: "read_file", args: JSON.stringify({ path: "a.ts" }) },
    ]);
    expect(msgs[2]).toMatchObject({ role: "tool", content: "file body", toolName: "read_file", toolCallId: "t1" });
  });

  it("omits a tool row for a call that never finished", () => {
    const msgs = foldedToMsgs(
      foldAgentEvents([
        assistantMessage("working", { toolCalls: [{ toolCallId: "t1", name: "bash" }] }),
        toolStarted("t1", "bash"),
      ]),
    );
    expect(msgs.map((m) => m.role)).toEqual(["assistant"]);
  });

  it("renders a compaction marker as a system message with the compaction card", () => {
    const msgs = foldedToMsgs(
      foldAgentEvents([userMessage("one"), assistantMessage("first"), compacted("the gist")]),
    );
    const marker = msgs[2] as Extract<Msg, { role: "system" }>;
    expect(marker.role).toBe("system");
    expect(marker.compaction).toEqual({ count: 2, summary: "the gist", source: "agent" });
    // `content` stays a readable fallback for serialization and search.
    expect(marker.content).toContain("2 earlier messages");
  });

  it("singularises the fallback text for a single collapsed message", () => {
    const msgs = foldedToMsgs(foldAgentEvents([userMessage("one"), compacted("gist")]));
    const marker = msgs[1] as Extract<Msg, { role: "system" }>;
    expect(marker.content).toContain("1 earlier message");
    expect(marker.content).not.toContain("messages");
  });

  it("drops undefined toolCalls rather than emitting an empty array", () => {
    const msgs = foldedToMsgs(foldAgentEvents([assistantMessage("plain answer")]));
    const assistant = msgs[0] as Extract<Msg, { role: "assistant" }>;
    expect(assistant.toolCalls).toBeUndefined();
  });
});

describe("foldedToRunMessages — the Mission Control shape", () => {
  it("folds tool calls into the assistant row with full lifecycle", () => {
    const out = foldedToRunMessages(
      foldAgentEvents([
        userMessage("read it"),
        assistantMessage("reading", { toolCalls: [{ toolCallId: "t1", name: "read_file", input: { path: "a.ts" } }] }),
        toolStarted("t1", "read_file", { path: "a.ts" }),
        toolFinished("t1", "file body"),
      ]),
    );
    expect(out.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(out[1].tools).toEqual([
      {
        id: "t1",
        name: "read_file",
        input: { path: "a.ts" },
        summary: "read_file …",
        result: "file body",
        ok: true,
        status: "finished",
      },
    ]);
  });

  it("drops an assistant turn that produced neither text nor tools", () => {
    const out = foldedToRunMessages(foldAgentEvents([userMessage("hi"), assistantMessage("   ")]));
    expect(out.map((m) => m.role)).toEqual(["user"]);
  });

  it("keeps a text-free turn that did call a tool", () => {
    const out = foldedToRunMessages(
      foldAgentEvents([assistantMessage("", { toolCalls: [{ toolCallId: "t1", name: "grep" }] })]),
    );
    expect(out).toHaveLength(1);
    expect(out[0].tools).toHaveLength(1);
  });

  it("skips the compaction marker — RunMessage has no role for it", () => {
    // The wire contract is "user" | "assistant" (the Rust struct and every
    // Delegate adapter agree), so the model's context bookkeeping stays out of
    // Mission Control's Conversation.
    const out = foldedToRunMessages(
      foldAgentEvents([userMessage("one"), assistantMessage("first"), compacted("gist"), userMessage("two")]),
    );
    expect(out.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });
});

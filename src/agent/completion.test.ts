import { describe, expect, it } from "vitest";
import { createFold, foldedToMsgs } from "./foldEvents";
import type { AgentEvent, AgentMode } from "./types";
import { createTurnDriver } from "../components/ai/turnDriver";
import type { Msg } from "../components/ai/types";

const start = (mode: AgentMode = "goal"): AgentEvent => ({ type: "run_started", runId: "r", cwd: "/workspace", mode, provider: "ollama", model: "local", ts: 1 });
const answer: AgentEvent = { type: "assistant_message", runId: "r", messageId: "a", content: [{ type: "text", text: "Updated the settings form." }], ts: 4 };
const done: AgentEvent = { type: "run_result", runId: "r", result: { status: "done" }, ts: 5 };
const changed: AgentEvent = { type: "file_changed", runId: "r", path: "src/settings.tsx", oldHash: "a", newHash: "b", ts: 2 };
const command: AgentEvent = { type: "tool_call_started", runId: "r", toolCallId: "c", capability: "run_command", name: "project_check", input: { command: "npm test" }, summary: "Run tests", ts: 2 };
const result: AgentEvent = { type: "tool_call_finished", runId: "r", toolCallId: "c", result: { ok: false, content: "One test failed" }, ts: 3 };

function cards(messages: Msg[]) {
  return messages.flatMap((message) => message.role === "system" && message.completion ? [message.completion] : []);
}

describe("completed run evidence", () => {
  it("only appears after a clean terminal event, deduplicates files and preserves failures", () => {
    const fold = createFold();
    [start(), changed, changed, command, result, answer].forEach((event) => fold.apply(event));
    expect(cards(foldedToMsgs(fold.rows()))).toEqual([]);
    fold.apply(done);
    fold.apply(done);
    expect(cards(foldedToMsgs(fold.rows()))).toEqual([{
      runId: "r", completedAt: 5, outcome: "Updated the settings form.", files: ["src/settings.tsx"],
      commands: [{ id: "c", label: "npm test", status: "failed", output: "One test failed" }], warnings: [],
    }]);
  });

  it("does not label read tools as checks or an unfinished command as passed", () => {
    const fold = createFold();
    [start(), { ...command, toolCallId: "read", capability: "read_workspace", name: "read_file" } as AgentEvent,
      command, answer, done].forEach((event) => fold.apply(event));
    expect(cards(foldedToMsgs(fold.rows()))[0].commands).toEqual([{ id: "c", label: "npm test", status: "unknown" }]);
  });

  it.each(["chat", "plan"] as const)("does not add coding completion cards to %s", (mode) => {
    const fold = createFold();
    [start(mode), answer, done].forEach((event) => fold.apply(event));
    expect(cards(foldedToMsgs(fold.rows()))).toEqual([]);
  });

  it.each(["cancelled", "max_turns"] as const)("does not claim completion for %s", (status) => {
    const fold = createFold();
    [start(), answer, { ...done, result: { status } } as AgentEvent].forEach((event) => fold.apply(event));
    expect(cards(foldedToMsgs(fold.rows()))).toEqual([]);
  });

  it.each(["cancelled", "max_turns"] as const)("hands over the files %s left behind, marked partial", (status) => {
    const fold = createFold();
    [start(), changed, answer, { ...done, result: { status } } as AgentEvent].forEach((event) => fold.apply(event));
    const [card] = cards(foldedToMsgs(fold.rows()));
    expect(card.stopped).toBe(true);
    expect(card.files).toEqual(["src/settings.tsx"]);
    expect(card.warnings[0]).toContain("stopped before finishing");
  });

  it("keeps each attempt's evidence separate when the conversation continues", () => {
    const fold = createFold();
    [start(), changed, command, result, answer, done, start(), answer, done].forEach((event) => fold.apply(event));
    const completed = cards(foldedToMsgs(fold.rows()));
    expect(completed).toHaveLength(2);
    expect(completed[0].files).toHaveLength(1);
    expect(completed[1].files).toEqual([]);
    expect(completed[1].commands).toEqual([]);
  });

  const failed: AgentEvent = { type: "run_error", runId: "r", error: { code: "provider_unavailable", message: "Disconnected", retryable: true }, ts: 5 };

  it("does not add a completion card for a terminal error that changed nothing", () => {
    const fold = createFold();
    [start(), answer, failed].forEach((event) => fold.apply(event));
    expect(cards(foldedToMsgs(fold.rows()))).toEqual([]);
  });

  it("opens the work a failed run had already applied", () => {
    // The API-key regression: a run wrote two files, then died on a key it
    // could no longer resolve. The edits were on disk with no way to review
    // them as a set.
    const fold = createFold();
    [start(), changed, command, result, answer, failed].forEach((event) => fold.apply(event));
    expect(cards(foldedToMsgs(fold.rows()))).toEqual([{
      runId: "r", completedAt: 5, outcome: "Disconnected", files: ["src/settings.tsx"],
      commands: [{ id: "c", label: "npm test", status: "failed", output: "One test failed" }],
      warnings: ["The run stopped before finishing — this work is partial."], stopped: true,
    }]);
  });

  it("does not add a second card when the run already reported a result", () => {
    const fold = createFold();
    [start(), changed, answer, done, failed].forEach((event) => fold.apply(event));
    expect(cards(foldedToMsgs(fold.rows()))).toHaveLength(1);
  });

  it("renders the same evidence live and on replay, retaining queued messages", () => {
    const queued: Msg = { role: "user", content: "Next task", queueState: "queued" };
    let messages: Msg[] = [{ role: "assistant", content: "" }, queued];
    const driver = createTurnDriver({ assistantIndex: 0, delegate: {}, pricing: null, read: () => messages, commit: (next) => { messages = next; } });
    const fold = createFold();
    for (const event of [start(), changed, command, result, answer, done]) {
      const handled = driver.handleEvent(event);
      if (event.type === "run_result" || event.type === "file_changed") expect(handled).toBe(false);
      fold.apply(event);
    }
    driver.finish();
    expect(cards(messages)).toEqual(cards(foldedToMsgs(fold.rows())));
    expect(messages[messages.length - 1]).toBe(queued);
  });
});

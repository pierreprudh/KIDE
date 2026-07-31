import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryStorage } from "../../testStorage";
import type { Conversation } from "./types";
import {
  CONVERSATIONS_CHANGED_EVENT,
  persistConversation,
} from "./utils";

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: "new-conversation",
    title: "Build the feature",
    msgs: [{ role: "user", content: "Build the feature" }],
    updatedAt: 1,
    provider: "openai",
    model: "gpt-5.6",
    cwd: "/workspace",
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
  vi.stubGlobal("window", new EventTarget());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("persistConversation navigation updates", () => {
  it("notifies Focus when a new conversation is first persisted with its model", () => {
    let updates = 0;
    let changedConversation: string | undefined;
    window.addEventListener(CONVERSATIONS_CHANGED_EVENT, (event) => {
      updates += 1;
      changedConversation = (event as CustomEvent<{ conversationId: string }>).detail?.conversationId;
    });

    const saved = persistConversation(conversation());

    expect(saved[0].model).toBe("gpt-5.6");
    expect(updates).toBe(1);
    expect(changedConversation).toBe("new-conversation");
  });

  it("does not notify on streaming-only message and timestamp changes", () => {
    let updates = 0;
    window.addEventListener(CONVERSATIONS_CHANGED_EVENT, () => updates += 1);
    const original = conversation();
    const saved = persistConversation(original);
    updates = 0;

    persistConversation(
      conversation({
        msgs: [...original.msgs, { role: "assistant", content: "One more token" }],
        updatedAt: 2,
      }),
      saved,
    );

    expect(updates).toBe(0);
  });

  it("notifies when the selected model changes", () => {
    let updates = 0;
    window.addEventListener(CONVERSATIONS_CHANGED_EVENT, () => updates += 1);
    const saved = persistConversation(conversation());
    updates = 0;

    persistConversation(conversation({ model: "claude-sonnet-4-6" }), saved);

    expect(updates).toBe(1);
  });
});

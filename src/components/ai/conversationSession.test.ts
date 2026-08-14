import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Conversation, Msg } from "./types";
import { memoryStorage } from "../../testStorage";
import {
  applyConversationSessionTransition,
  conversationSessionReducer,
  restoreConversationSession,
  snapshotConversationSession,
  type ConversationSession,
} from "./conversationSession";
import type { PanelSession } from "./storedConversations";

const userMessage: Msg = { role: "user", content: "Inspect the workspace" };

function session(overrides: Partial<ConversationSession> = {}): ConversationSession {
  return {
    conversationId: "conversation-a",
    messages: [userMessage, { role: "assistant", content: "Working" }],
    provider: "ollama",
    model: "qwen3",
    workspaceRoot: "/workspace",
    branch: "feature/a",
    worktree: "a",
    forkedFrom: null,
    run: { active: false, activity: null },
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("restoreConversationSession", () => {
  it("hydrates identity, messages, provider, model, lineage, and Git metadata atomically", () => {
    const saved: Conversation = {
      id: "saved-run",
      title: "Saved",
      msgs: [userMessage],
      updatedAt: 42,
      provider: "openai",
      model: "gpt-5.4",
      cwd: "/workspace",
      branch: "feature/saved",
      worktree: "saved-tree",
      forkedFrom: {
        conversationId: "parent",
        title: "Parent",
        messageIndex: 2,
        createdAt: 10,
        mode: "chat",
      },
    };
    localStorage.setItem("klide-conversations", JSON.stringify([saved]));
    localStorage.setItem(
      "klide.panelSession.ai-main",
      JSON.stringify({ convoId: saved.id, active: false }),
    );

    expect(
      restoreConversationSession({
        panelId: "ai-main",
        provider: "ollama",
        model: "qwen3",
        workspaceRoot: "/workspace",
      }),
    ).toEqual({
      conversationId: saved.id,
      messages: saved.msgs,
      provider: "openai",
      model: "gpt-5.4",
      workspaceRoot: "/workspace",
      branch: "feature/saved",
      worktree: "saved-tree",
      forkedFrom: saved.forkedFrom,
      run: { active: false, activity: null },
    });
  });

  it("does not carry a hosted panel binding into another Workspace", () => {
    localStorage.setItem(
      "klide-conversations",
      JSON.stringify([
        {
          id: "other-workspace",
          title: "Other",
          msgs: [userMessage],
          updatedAt: 10,
          provider: "openai",
          model: "gpt-5.4",
          cwd: "/other",
        },
      ]),
    );
    localStorage.setItem(
      "klide.panelSession.ai-main",
      JSON.stringify({ convoId: "other-workspace", active: false }),
    );

    const restored = restoreConversationSession({
      panelId: "ai-main",
      provider: "openai",
      model: "gpt-5.4",
      workspaceRoot: "/workspace",
      createId: () => "fresh",
    });

    expect(restored.conversationId).toBe("fresh");
    expect(restored.messages).toEqual([]);
  });

  it("restores a scoped empty hosted Conversation before its first Run", () => {
    localStorage.setItem(
      "klide.panelSession.ai-main",
      JSON.stringify({
        convoId: "empty-conversation",
        provider: "openai",
        workspaceRoot: "/workspace",
      }),
    );

    const restored = restoreConversationSession({
      panelId: "ai-main",
      provider: "openai",
      model: "gpt-5.4",
      workspaceRoot: "/workspace",
      createId: () => "fresh",
    });

    expect(restored.conversationId).toBe("empty-conversation");
    expect(restored.messages).toEqual([]);
  });

  it("starts a Focus hero submission from the selected Provider/model instead of a restored panel binding", () => {
    localStorage.setItem(
      "klide-conversations",
      JSON.stringify([
        {
          id: "failed-openrouter-run",
          title: "Failed",
          msgs: [],
          updatedAt: 10,
          provider: "openrouter",
          model: "sakana/fugu-ultra",
          cwd: "/workspace",
        },
      ]),
    );
    localStorage.setItem(
      "klide.panelSession.ai-main",
      JSON.stringify({
        convoId: "failed-openrouter-run",
        provider: "openrouter",
        workspaceRoot: "/workspace",
      }),
    );

    const restored = restoreConversationSession({
      panelId: "ai-main",
      provider: "custom:ontraak-prod",
      model: "qwen3.6:latest",
      workspaceRoot: "/workspace",
      startFresh: true,
      createId: () => "fresh-prod-run",
    });

    expect(restored).toMatchObject({
      conversationId: "fresh-prod-run",
      messages: [],
      provider: "custom:ontraak-prod",
      model: "qwen3.6:latest",
    });
  });

  it("keeps a Delegate panel binding even before it has renderable messages", () => {
    localStorage.setItem(
      "klide.panelSession.delegate-panel",
      JSON.stringify({ convoId: "live-delegate", active: true }),
    );

    const restored = restoreConversationSession({
      panelId: "delegate-panel",
      provider: "codex",
      model: "",
      workspaceRoot: "/workspace",
      createId: () => "fresh",
    });

    expect(restored.conversationId).toBe("live-delegate");
  });

  it("does not reconnect a Delegate binding recorded for another Workspace", () => {
    localStorage.setItem(
      "klide.panelSession.delegate-panel",
      JSON.stringify({
        convoId: "other-delegate",
        provider: "codex",
        workspaceRoot: "/other",
      }),
    );

    const restored = restoreConversationSession({
      panelId: "delegate-panel",
      provider: "codex",
      model: "",
      workspaceRoot: "/workspace",
      createId: () => "fresh",
    });

    expect(restored.conversationId).toBe("fresh");
  });
});

describe("conversationSessionReducer", () => {
  it("switches Provider and model without changing Conversation identity or messages", () => {
    const current = session({ run: { active: true, activity: "thinking" } });
    const next = conversationSessionReducer(current, {
      type: "configured",
      provider: "openai",
      model: "gpt-5.4",
    });

    expect(next).toEqual({
      ...current,
      provider: "openai",
      model: "gpt-5.4",
    });
  });

  it("starts fresh without leaking lineage, Git metadata, messages, or Run activity", () => {
    const next = conversationSessionReducer(
      session({
        forkedFrom: {
          conversationId: "parent",
          title: "Parent",
          messageIndex: 1,
          createdAt: 1,
          mode: "chat",
        },
        run: { active: true, activity: "thinking" },
      }),
      { type: "fresh-started", conversationId: "conversation-b" },
    );

    expect(next).toMatchObject({
      conversationId: "conversation-b",
      messages: [],
      branch: null,
      worktree: null,
      forkedFrom: null,
      run: { active: false, activity: null },
      provider: "ollama",
      model: "qwen3",
      workspaceRoot: "/workspace",
    });
  });

  it("branches identity, messages, and lineage in one transition", () => {
    const next = conversationSessionReducer(session(), {
      type: "branched",
      conversationId: "branch-b",
      messageIndex: 0,
      mode: "chat",
      createdAt: 99,
    });

    expect(next.conversationId).toBe("branch-b");
    expect(next.messages).toEqual([userMessage]);
    expect(next.forkedFrom).toEqual({
      conversationId: "conversation-a",
      title: "Inspect the workspace",
      messageIndex: 0,
      createdAt: 99,
      mode: "chat",
    });
  });

  it("owns the Run activity transition", () => {
    const running = conversationSessionReducer(session(), {
      type: "run-started",
      activity: "thinking",
    });
    const settled = conversationSessionReducer(running, { type: "run-settled" });

    expect(running.run).toEqual({ active: true, activity: "thinking" });
    expect(settled.run).toEqual({ active: false, activity: null });
  });
});

describe("applyConversationSessionTransition — transitions carry their persist", () => {
  function fakeStore() {
    const writes: Array<{ panelId: string; binding: PanelSession }> = [];
    return {
      writes,
      write: (panelId: string, binding: PanelSession) => writes.push({ panelId, binding }),
    };
  }

  it("persists the fresh identity in the same transition that adopts it", () => {
    const store = fakeStore();

    const next = applyConversationSessionTransition(
      session(),
      { type: "fresh-started", conversationId: "fresh-b" },
      "ai-main",
      store.write,
    );

    expect(next.conversationId).toBe("fresh-b");
    expect(store.writes).toEqual([
      {
        panelId: "ai-main",
        binding: { convoId: "fresh-b", provider: "ollama", workspaceRoot: "/workspace" },
      },
    ]);
  });

  it("persists a resume with the resumed Conversation's own Provider", () => {
    const store = fakeStore();
    const saved: Conversation = {
      id: "saved-run",
      title: "Saved",
      msgs: [userMessage],
      updatedAt: 42,
      provider: "openai",
      model: "gpt-5.4",
      cwd: "/workspace",
    };

    applyConversationSessionTransition(
      session(),
      { type: "resumed", conversation: saved },
      "ai-main",
      store.write,
    );

    expect(store.writes).toEqual([
      {
        panelId: "ai-main",
        binding: { convoId: "saved-run", provider: "openai", workspaceRoot: "/workspace" },
      },
    ]);
  });

  it("persists a branch under its new identity", () => {
    const store = fakeStore();

    applyConversationSessionTransition(
      session(),
      { type: "branched", conversationId: "branch-b", messageIndex: 0, mode: "chat", createdAt: 9 },
      "ai-main",
      store.write,
    );

    expect(store.writes.map((w) => w.binding.convoId)).toEqual(["branch-b"]);
  });

  it("re-asserts the binding when a Run starts, so a mid-run view switch reattaches", () => {
    const store = fakeStore();

    applyConversationSessionTransition(
      session(),
      { type: "run-started", activity: "thinking" },
      "ai-main",
      store.write,
    );

    expect(store.writes.map((w) => w.binding.convoId)).toEqual(["conversation-a"]);
  });

  it("does not write for message streaming, Run settle, or a model-only configure", () => {
    const store = fakeStore();
    const current = session();

    applyConversationSessionTransition(
      current,
      { type: "messages-replaced", messages: [userMessage] },
      "ai-main",
      store.write,
    );
    applyConversationSessionTransition(current, { type: "run-settled" }, "ai-main", store.write);
    applyConversationSessionTransition(
      current,
      { type: "configured", model: "qwen3.5" },
      "ai-main",
      store.write,
    );

    expect(store.writes).toEqual([]);
  });

  it("persists a Provider change under the same Conversation identity", () => {
    const store = fakeStore();

    applyConversationSessionTransition(
      session(),
      { type: "configured", provider: "openai", model: "gpt-5.4" },
      "ai-main",
      store.write,
    );

    expect(store.writes).toEqual([
      {
        panelId: "ai-main",
        binding: { convoId: "conversation-a", provider: "openai", workspaceRoot: "/workspace" },
      },
    ]);
  });

  it("skips the durable write for a panel without an identity, but still transitions", () => {
    const store = fakeStore();

    const next = applyConversationSessionTransition(
      session(),
      { type: "fresh-started", conversationId: "fresh-b" },
      undefined,
      store.write,
    );

    expect(next.conversationId).toBe("fresh-b");
    expect(store.writes).toEqual([]);
  });

  it("writes the real panel binding when no store is injected", () => {
    applyConversationSessionTransition(
      session(),
      { type: "fresh-started", conversationId: "fresh-durable" },
      "ai-main",
    );

    expect(JSON.parse(localStorage.getItem("klide.panelSession.ai-main") ?? "null")).toEqual({
      convoId: "fresh-durable",
      provider: "ollama",
      workspaceRoot: "/workspace",
    });
  });
});

describe("snapshotConversationSession", () => {
  it("persists one coherent Conversation and removes a trailing empty assistant placeholder", () => {
    const snapshot = snapshotConversationSession(
      session({ messages: [userMessage, { role: "assistant", content: "" }] }),
      123,
    );

    expect(snapshot).toEqual({
      id: "conversation-a",
      title: "Inspect the workspace",
      msgs: [userMessage],
      updatedAt: 123,
      // `userMessage` carries no `ts` (it predates per-message timestamps), so
      // the snapshot falls back to the save time for the conversation's start.
      createdAt: 123,
      provider: "ollama",
      model: "qwen3",
      cwd: "/workspace",
      branch: "feature/a",
      worktree: "a",
      forkedFrom: null,
    });
  });
});

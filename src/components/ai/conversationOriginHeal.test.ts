import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryStorage } from "../../testStorage";
import type { Conversation, Msg } from "./types";
import {
  healStoredConversationOrigins,
  healedConversationOrigin,
  originDelegateOf,
} from "./conversationOriginHeal";
import { loadConversations, saveConversations } from "./storedConversations";

const ask: Msg = { role: "user", content: "Refactor the loop" };
function answer(delegateProvider?: string): Msg {
  return { role: "assistant", content: "Done", delegateProvider };
}

function conversation(overrides: Partial<Conversation> = {}): Conversation {
  return {
    id: "thread",
    title: "Refactor the loop",
    msgs: [ask, answer()],
    updatedAt: 10,
    provider: "openrouter",
    model: "deepseek/deepseek-v4",
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

describe("originDelegateOf", () => {
  it("reads the delegate off the first assistant turn", () => {
    expect(originDelegateOf([ask, answer("Claude Code")])).toBe("claude-code");
    expect(originDelegateOf([ask, answer("Oh My Pi")])).toBe("omp");
  });

  it("is null when the first turn came from no delegate", () => {
    expect(originDelegateOf([ask, answer()])).toBeNull();
    expect(originDelegateOf([])).toBeNull();
  });

  it("is null for a CLI name this build cannot resolve", () => {
    expect(originDelegateOf([ask, answer("Some Retired CLI")])).toBeNull();
  });
});

describe("healedConversationOrigin", () => {
  it("restores the delegate a relabelled thread began on, and drops the foreign model", () => {
    const healed = healedConversationOrigin(
      conversation({ msgs: [ask, answer("Claude Code")] }),
    );
    expect(healed?.provider).toBe("claude-code");
    // OpenRouter's model belonged to no turn in this thread.
    expect(healed?.model).toBeNull();
  });

  it("leaves a correct record alone", () => {
    expect(
      healedConversationOrigin(
        conversation({ provider: "claude-code", model: "default", msgs: [ask, answer("Claude Code")] }),
      ),
    ).toBeNull();
    expect(healedConversationOrigin(conversation())).toBeNull();
  });

  it("leaves a thread that only later moved to a CLI alone", () => {
    // First turn came from an API provider (no stamp), so the origin is
    // unrecoverable — guessing "Claude Code" from the second turn would trade
    // one wrong label for another.
    expect(
      healedConversationOrigin(
        conversation({ msgs: [ask, answer(), ask, answer("Claude Code")] }),
      ),
    ).toBeNull();
  });
});

describe("healStoredConversationOrigins", () => {
  it("heals the index in place without touching activity time or correct rows", () => {
    saveConversations([
      conversation({ id: "mislabelled", msgs: [ask, answer("Claude Code")], updatedAt: 7 }),
      conversation({ id: "genuine-router", updatedAt: 5 }),
    ]);

    expect(healStoredConversationOrigins()).toBe(1);

    const stored = loadConversations<Conversation>();
    const healed = stored.find((c) => c.id === "mislabelled");
    expect(healed?.provider).toBe("claude-code");
    expect(healed?.updatedAt).toBe(7);
    expect(stored.find((c) => c.id === "genuine-router")?.provider).toBe("openrouter");
  });

  it("is idempotent — a second boot changes nothing", () => {
    saveConversations([conversation({ msgs: [ask, answer("Codex")] })]);
    expect(healStoredConversationOrigins()).toBe(1);
    expect(healStoredConversationOrigins()).toBe(0);
    expect(loadConversations<Conversation>()[0].provider).toBe("codex");
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { memoryStorage } from "../../testStorage";
import type { Conversation } from "./types";
import {
  CONVERSATIONS_CHANGED_EVENT,
  conversationDuration,
  conversationStartedAt,
  loadConversations,
  persistConversation,
  saveConversations,
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

function quotaStorage(maxValueLength: number): Storage {
  const values = new Map<string, string>();
  return {
    get length() {
      return values.size;
    },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => {
      if (value.length > maxValueLength) {
        throw new DOMException("Conversation storage quota exceeded", "QuotaExceededError");
      }
      values.set(key, value);
    },
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

  it("merges against durable storage instead of erasing a sibling panel's write", () => {
    // Both panels mounted before either conversation existed, so each holds
    // the same stale local snapshot. The durable store must be the merge
    // authority or whichever panel writes second erases the first.
    const stalePanelSnapshot: Conversation[] = [];
    persistConversation(
      conversation({ id: "panel-a", title: "Panel A", updatedAt: 1 }),
      stalePanelSnapshot,
    );
    persistConversation(
      conversation({ id: "panel-b", title: "Panel B", updatedAt: 2 }),
      stalePanelSnapshot,
    );

    expect(loadConversations<Conversation>().map((item) => item.id)).toEqual([
      "panel-b",
      "panel-a",
    ]);
  });

  it("retries a quota-limited write after removing only the oldest snapshots", () => {
    vi.stubGlobal("localStorage", quotaStorage(500));
    const newest = conversation({
      id: "newest",
      title: "Newest",
      msgs: [{ role: "user", content: "n".repeat(180) }],
      updatedAt: 2,
    });
    const oldest = conversation({
      id: "oldest",
      title: "Oldest",
      msgs: [{ role: "user", content: "o".repeat(180) }],
      updatedAt: 1,
    });

    const saved = saveConversations([newest, oldest]);

    expect(saved.map((item) => item.id)).toEqual(["newest"]);
    expect(loadConversations<Conversation>().map((item) => item.id)).toEqual(["newest"]);
  });
});

describe("conversation start time", () => {
  it("takes the start from the first stamped message and holds it across saves", () => {
    const first = persistConversation(
      conversation({ msgs: [{ role: "user", content: "Build the feature", ts: 1_000 }], updatedAt: 1_000 }),
    );
    expect(first[0].createdAt).toBe(1_000);

    // Streaming rewrites `updatedAt` on every token; the start must not move.
    const later = persistConversation(
      conversation({
        msgs: [
          { role: "user", content: "Build the feature", ts: 1_000 },
          { role: "assistant", content: "on it", ts: 9_000 },
        ],
        updatedAt: 9_000,
      }),
      first,
    );
    expect(later[0].createdAt).toBe(1_000);
    expect(conversationDuration(later[0])).toBe(8_000);
  });

  it("keeps a legacy record's start rather than resetting it to the save time", () => {
    // Written before timestamps existed: no createdAt, no message `ts`.
    const legacy: Conversation[] = [conversation({ updatedAt: 5_000 })];
    saveConversations(legacy);
    const saved = persistConversation(conversation({ updatedAt: 12_000 }));
    expect(saved[0].createdAt).toBe(5_000);
  });

  it("falls back to the last-activity time for a record with nothing to date it", () => {
    expect(conversationStartedAt(conversation({ updatedAt: 42 }))).toBe(42);
  });
});

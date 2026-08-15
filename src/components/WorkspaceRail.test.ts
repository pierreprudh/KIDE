// The shared rail's pure parts. These used to live beside FocusMode, back when
// the rail was Focus's alone; both shells render it now, so a regression here
// breaks navigation everywhere rather than in one layout.

import { describe, expect, it } from "vitest";

import {
  railProjectRoots,
  retrievableConversation,
  visibleProviderConversations,
} from "./WorkspaceRail";
import type { Conversation } from "./ai/types";

const KIDE = "/Users/pierre/Documents/Private/KIDE";
const RUN = `${KIDE}-worktrees/klide-run-how-to-report-a-bug-on-codex-app-a9dc5e94`;

describe("rail project list", () => {
  it("keeps a linked run under its owning workspace", () => {
    expect(railProjectRoots([RUN, KIDE], RUN)).toEqual([KIDE]);
  });

  it("does not append an active linked run as another workspace", () => {
    expect(railProjectRoots([KIDE], RUN)).toEqual([KIDE]);
  });
});

describe("rail conversation resume", () => {
  const saved: Conversation = {
    id: "saved-1",
    title: "Saved task",
    msgs: [{ role: "user", content: "hello" }],
    updatedAt: 1,
  };

  it("re-resolves the durable record instead of trusting the rendered row", () => {
    const staleRow = { ...saved, title: "Stale title" };
    expect(retrievableConversation(staleRow.id, [saved])).toBe(saved);
  });

  it("returns null when the rendered conversation has disappeared", () => {
    expect(retrievableConversation("missing", [saved])).toBeNull();
  });
});

describe("rail conversation disclosure", () => {
  const conversations = Array.from({ length: 7 }, (_, index): Conversation => ({
    id: `conversation-${index + 1}`,
    title: `Conversation ${index + 1}`,
    msgs: [],
    updatedAt: 7 - index,
  }));

  it("shows at most five conversations before More is selected", () => {
    expect(visibleProviderConversations(conversations, false).map((c) => c.id)).toEqual([
      "conversation-1",
      "conversation-2",
      "conversation-3",
      "conversation-4",
      "conversation-5",
    ]);
  });

  it("reveals every conversation after More is selected", () => {
    expect(visibleProviderConversations(conversations, true)).toEqual(conversations);
  });

  it("keeps an older open conversation inside the collapsed five-row window", () => {
    expect(
      visibleProviderConversations(conversations, false, new Set(["conversation-7"])).map(
        (c) => c.id,
      ),
    ).toEqual([
      "conversation-1",
      "conversation-2",
      "conversation-3",
      "conversation-4",
      "conversation-7",
    ]);
  });

  // Free mode can hold several conversations at once, across panels. The rail
  // is what says which are open, so every one of them has to survive the
  // collapse — one pinned row was the old single-selection assumption.
  it("keeps every open conversation, not just one", () => {
    expect(
      visibleProviderConversations(
        conversations,
        false,
        new Set(["conversation-6", "conversation-7"]),
      ).map((c) => c.id),
    ).toEqual([
      "conversation-1",
      "conversation-2",
      "conversation-3",
      "conversation-6",
      "conversation-7",
    ]);
  });

  it("does not grow the window past the row limit when several are open", () => {
    const open = new Set(["conversation-5", "conversation-6", "conversation-7"]);
    const visible = visibleProviderConversations(conversations, false, open).map((c) => c.id);

    // A collapsed group stays a fixed height: all three open ones are kept and
    // the two newest fill what is left. conversation-5 is open AND recent —
    // the row it would have occupied anyway must not be spent twice.
    expect(visible).toEqual([
      "conversation-1",
      "conversation-2",
      "conversation-5",
      "conversation-6",
      "conversation-7",
    ]);
  });

  it("pins nothing when no conversation is open", () => {
    expect(visibleProviderConversations(conversations, false).map((c) => c.id)).toEqual([
      "conversation-1",
      "conversation-2",
      "conversation-3",
      "conversation-4",
      "conversation-5",
    ]);
  });
});

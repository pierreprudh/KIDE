import { describe, expect, it } from "vitest";
import {
  DEFAULT_AI_PANEL_ID,
  admissionBase,
  admissionNeedsWorkbench,
  admissionSurface,
  conversationSessionKey,
  initialHandoffFor,
  modificationAcceptanceMode,
  panelWorkspace,
  resumeConversationFor,
  surfaceShowsOneAiPanel,
  type PendingAiPanel,
} from "./panelHost";

describe("conversationSessionKey", () => {
  it("keeps panel identity stable inside one Workspace", () => {
    expect(conversationSessionKey("ai-main", "/workspace")).toBe(
      conversationSessionKey("ai-main", "/workspace"),
    );
  });

  it("rotates panel identity when its effective Workspace changes", () => {
    expect(conversationSessionKey("ai-main", "/workspace-a")).not.toBe(
      conversationSessionKey("ai-main", "/workspace-b"),
    );
  });

  it("preserves a surface-specific key while still scoping it to the Workspace", () => {
    expect(conversationSessionKey("ai-racer", "/workspace", "focus-ai-racer")).toBe(
      "focus-ai-racer::/workspace",
    );
  });

  it("spells seat 0 the old way, so a panel nobody reseated never remounts", () => {
    expect(conversationSessionKey("ai-main", "/workspace", undefined, 0)).toBe(
      conversationSessionKey("ai-main", "/workspace"),
    );
  });

  it("rotates identity when a one-slot surface reuses the panel for another session", () => {
    expect(conversationSessionKey("ai-main", "/workspace", undefined, 1)).not.toBe(
      conversationSessionKey("ai-main", "/workspace", undefined, 2),
    );
  });
});

describe("where an admission can be rendered", () => {
  it("counts every surface but free (floating) mode as a single AI slot", () => {
    expect(surfaceShowsOneAiPanel("focus")).toBe(true);
    expect(surfaceShowsOneAiPanel("anchored")).toBe(true);
    expect(surfaceShowsOneAiPanel("grid")).toBe(true);
    expect(surfaceShowsOneAiPanel("free")).toBe(false);
  });

  it("sends an interactive delegate session to the workbench — Focus hosts no terminal", () => {
    expect(
      admissionNeedsWorkbench({ kind: "handoff", provider: "claude-code" }),
    ).toBe(true);
    expect(
      admissionNeedsWorkbench({ kind: "reattach", provider: "codex" }),
    ).toBe(true);
  });

  it("leaves a Klide conversation where it is — Focus renders it as chat", () => {
    expect(admissionNeedsWorkbench({ kind: "resume-run" })).toBe(false);
    expect(admissionNeedsWorkbench({ kind: "fork" })).toBe(false);
    expect(admissionNeedsWorkbench({ kind: "handoff", provider: "ollama" })).toBe(false);
  });

  it("lets Continue in Focus name its surface from anywhere", () => {
    expect(admissionBase("focus-resume", "anchored")).toBe("focus");
    expect(admissionBase("focus-resume", "free")).toBe("focus");
    expect(admissionBase("handoff", "anchored")).toBe("anchored");
  });

  it("resolves the slot question against the surface the admission lands on", () => {
    // A delegate resume started from Focus is decided by the workbench it
    // moves to, not by Focus.
    expect(admissionSurface(true, "focus", "free")).toBe("free");
    expect(admissionSurface(true, "focus", "anchored")).toBe("anchored");
    expect(admissionSurface(false, "focus", "free")).toBe("focus");
    expect(admissionSurface(true, "grid", "free")).toBe("grid");
  });
});

const pendingFor = (panelId: string, extra?: Partial<PendingAiPanel>): PendingAiPanel => ({
  panelId,
  provider: "claude-code",
  resumeSessionId: null,
  initialTask: null,
  conversationId: null,
  ...extra,
});

describe("initialHandoffFor", () => {
  it("opens a handoff on a new thread, so a reused panel cannot keep the old one", () => {
    const resume = initialHandoffFor(
      "ai-main",
      "ollama",
      pendingFor("ai-main", { resumeSessionId: "sess-1" }),
    );
    expect(resume.initialStartFresh).toBe(true);
    // A panel nobody handed anything to restores as it always did.
    expect(initialHandoffFor("ai-main", "ollama", null).initialStartFresh).toBe(false);
  });

  it("targets only the panel the pending handoff names", () => {
    const pending = pendingFor("ai-2", {
      resumeSessionId: "sess-1",
      initialTask: "fix the tests",
      conversationId: "convo-9",
    });

    const matched = initialHandoffFor("ai-2", "ollama", pending);
    expect(matched.matched).toBe(true);
    expect(matched.initialProvider).toBe("claude-code");
    expect(matched.initialResumeSessionId).toBe("sess-1");
    expect(matched.initialTask).toBe("fix the tests");
    expect(matched.initialConversationId).toBe("convo-9");
    // A reattach names its conversation — restoring it is the whole point.
    expect(matched.initialStartFresh).toBe(false);

    // Another mounted panel in the same render must NOT adopt the handoff —
    // it keeps its own provider and receives no resume/task/conversation.
    const other = initialHandoffFor(DEFAULT_AI_PANEL_ID, "ollama", pending);
    expect(other.matched).toBe(false);
    expect(other.initialProvider).toBe("ollama");
    expect(other.initialResumeSessionId).toBeUndefined();
    expect(other.initialTask).toBeUndefined();
    expect(other.initialConversationId).toBeUndefined();
  });

  it("without a pending handoff every panel starts on its own provider", () => {
    const handoff = initialHandoffFor("ai-2", "mlx", null);
    expect(handoff.matched).toBe(false);
    expect(handoff.initialProvider).toBe("mlx");
  });

  it("normalizes the handoff's nullable fields to undefined props", () => {
    // A "Resume in CLI" handoff carries no conversation id (that's reattach
    // only) — the prop must be undefined, not null, so AiPanel's defaults win.
    const handoff = initialHandoffFor("ai-2", undefined, pendingFor("ai-2"));
    expect(handoff.matched).toBe(true);
    expect(handoff.initialConversationId).toBeUndefined();
    expect(handoff.initialResumeSessionId).toBeUndefined();
    expect(handoff.initialTask).toBeUndefined();
  });
});

describe("resumeConversationFor", () => {
  it("only the targeted panel adopts the resumed conversation", () => {
    const convo = { id: "run-1" };
    const target = { panelId: "ai-2", convo };
    expect(resumeConversationFor("ai-2", target)).toBe(convo);
    expect(resumeConversationFor(DEFAULT_AI_PANEL_ID, target)).toBeNull();
    expect(resumeConversationFor("ai-2", null)).toBeNull();
  });
});

describe("panelWorkspace", () => {
  it("a worktree-pinned panel runs in its own checkout and shows the worktree name", () => {
    const ws = panelWorkspace(
      { cwd: "/repo/.worktrees/fix-tests/" },
      "/repo",
      true
    );
    expect(ws.root).toBe("/repo/.worktrees/fix-tests/");
    expect(ws.worktreeName).toBe("fix-tests");
  });

  it("can explicitly ignore a panel cwd for a main-checkout-only projection", () => {
    const ws = panelWorkspace({ cwd: "/repo/.worktrees/fix-tests" }, "/repo", false);
    expect(ws.root).toBe("/repo");
    expect(ws.worktreeName).toBeUndefined();
  });

  it("falls back to the global workspace when the panel has no cwd", () => {
    const ws = panelWorkspace(undefined, "/repo", true);
    expect(ws.root).toBe("/repo");
    expect(ws.worktreeName).toBeUndefined();
  });

  it("does not label a saved cwd equal to the Workspace root as a worktree", () => {
    const ws = panelWorkspace({ cwd: "/repo/" }, "/repo", true);
    expect(ws.root).toBe("/repo");
    expect(ws.worktreeName).toBeUndefined();
  });
});

describe("modificationAcceptanceMode", () => {
  it("offers acceptance while a reviewed diff is pending", () => {
    expect(modificationAcceptanceMode(true, 0, true)).toBe("pending-diff");
  });

  it("offers acceptance for applied changes after the run settles", () => {
    expect(modificationAcceptanceMode(false, 2, false)).toBe("applied-run");
  });

  it("stays quiet when no change is actionable", () => {
    expect(modificationAcceptanceMode(false, 0, false)).toBeNull();
    expect(modificationAcceptanceMode(false, 2, true)).toBeNull();
  });
});

// The tab/split bookkeeping around the native shells. The invariant worth
// protecting: a pane never shows a shell that another pane is already showing,
// and closing a tab always leaves a coherent (activeId, splitId) pair — a stale
// id in either slot renders a pane bound to a shell Rust has already dropped.

import { beforeEach, describe, expect, it, vi } from "vitest";

const invoked: { cmd: string; args: unknown }[] = [];
vi.mock("@tauri-apps/api/core", () => ({
  invoke: (cmd: string, args: unknown) => {
    invoked.push({ cmd, args });
    return Promise.resolve();
  },
}));

const {
  addTerminal,
  closeTerminal,
  ensureTerminal,
  getTerminals,
  IDLE_TERMINAL_TITLE,
  renameTerminal,
  resetTerminalsForTest,
  selectTerminal,
  terminalExited,
  toggleSplitTerminal,
} = await import("./terminals");

beforeEach(() => {
  resetTerminalsForTest();
  invoked.length = 0;
});

describe("terminal tabs", () => {
  it("mints one shell on demand and reuses it", () => {
    const first = ensureTerminal();
    expect(ensureTerminal()).toBe(first);
    expect(getTerminals().tabs).toHaveLength(1);
  });

  it("focuses a newly added tab", () => {
    ensureTerminal();
    const second = addTerminal();
    expect(getTerminals().activeId).toBe(second);
    expect(getTerminals().tabs).toHaveLength(2);
  });

  it("kills the shell when a tab closes", () => {
    const first = ensureTerminal();
    const second = addTerminal();
    closeTerminal(second);
    expect(getTerminals().tabs.map((t) => t.id)).toEqual([first]);
    expect(getTerminals().activeId).toBe(first);
    expect(invoked).toEqual([{ cmd: "pty_close", args: { id: second } }]);
  });
});

describe("terminal split", () => {
  it("splits onto a NEW shell, never a second view of the same one", () => {
    const first = ensureTerminal();
    toggleSplitTerminal();
    const { activeId, splitId, tabs } = getTerminals();
    expect(activeId).toBe(first);
    expect(splitId).not.toBe(first);
    expect(splitId).not.toBeNull();
    expect(tabs).toHaveLength(2);
  });

  it("closing the split kills its shell too", () => {
    ensureTerminal();
    toggleSplitTerminal();
    const splitId = getTerminals().splitId;
    toggleSplitTerminal();
    expect(getTerminals().splitId).toBeNull();
    expect(getTerminals().tabs).toHaveLength(1);
    expect(invoked).toEqual([{ cmd: "pty_close", args: { id: splitId } }]);
  });

  it("swaps the panes when the split's own tab is selected", () => {
    const first = ensureTerminal();
    toggleSplitTerminal();
    const splitId = getTerminals().splitId!;
    selectTerminal(splitId);
    expect(getTerminals().activeId).toBe(splitId);
    expect(getTerminals().splitId).toBe(first);
  });

  it("promotes the split when the primary tab closes, and leaves no split", () => {
    const first = ensureTerminal();
    toggleSplitTerminal();
    const splitId = getTerminals().splitId!;
    closeTerminal(first);
    expect(getTerminals().activeId).toBe(splitId);
    expect(getTerminals().splitId).toBeNull();
    expect(getTerminals().tabs.map((t) => t.id)).toEqual([splitId]);
  });

  it("drops the tab when its shell exits on its own", () => {
    const first = ensureTerminal();
    const second = addTerminal();
    terminalExited(second);
    expect(getTerminals().tabs.map((t) => t.id)).toEqual([first]);
    expect(getTerminals().activeId).toBe(first);
    // Nothing to kill — the shell is already gone.
    expect(invoked).toHaveLength(0);
  });

  it("ignores an exit for a tab it doesn't have", () => {
    const first = ensureTerminal();
    terminalExited("term-does-not-exist");
    expect(getTerminals().tabs.map((t) => t.id)).toEqual([first]);
  });
});

describe("terminal titles", () => {
  it("starts idle and unnumbered, however many tabs there are", () => {
    ensureTerminal();
    addTerminal();
    expect(getTerminals().tabs.map((t) => t.title)).toEqual([
      IDLE_TERMINAL_TITLE,
      IDLE_TERMINAL_TITLE,
    ]);
  });

  it("takes the foreground process, then falls back when it ends", () => {
    const id = ensureTerminal();
    renameTerminal(id, "cargo");
    expect(getTerminals().tabs[0].title).toBe("cargo");
    // Rust sends an empty title when the prompt goes idle again.
    renameTerminal(id, "");
    expect(getTerminals().tabs[0].title).toBe(IDLE_TERMINAL_TITLE);
  });

  it("does not touch state for an unknown or unchanged title", () => {
    const id = ensureTerminal();
    const before = getTerminals();
    renameTerminal("term-nope", "vim");
    renameTerminal(id, IDLE_TERMINAL_TITLE);
    expect(getTerminals()).toBe(before);
  });
});

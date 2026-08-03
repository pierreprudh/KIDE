// Terminal tabs — which native shells exist, which one each pane shows.
//
// The shells themselves live in Rust (`pty.rs`, keyed by the ids minted here)
// and outlive every panel. This store is the frontend's matching bookkeeping,
// and it lives at module level rather than in a component for one reason: the
// workbench drawer and Focus's dock are never mounted at the same time, so
// component state would lose the tab list on every trip between them.
//
// Not persisted. A shell's identity is its live process; remembering tab titles
// across a restart would promise sessions that no longer exist.

import { invoke } from "@tauri-apps/api/core";

/** What an idle tab calls itself. Tabs aren't numbered: a number is a label
 *  about Klide's bookkeeping, not about your work. A tab says "Shell" until
 *  something is running in it, and then it says what that is. */
export const IDLE_TERMINAL_TITLE = "Shell";

export type TerminalTab = {
  id: string;
  /** `IDLE_TERMINAL_TITLE`, or the foreground process Rust last reported. */
  title: string;
};

export type TerminalsState = {
  tabs: TerminalTab[];
  /** The tab the primary pane shows. */
  activeId: string | null;
  /** The tab the second pane shows, or null when not split. Always a different
   *  tab than `activeId` — splitting mints a new shell rather than showing the
   *  same one twice, which would be two views of one prompt. */
  splitId: string | null;
};

type Listener = () => void;
const listeners = new Set<Listener>();

let state: TerminalsState = { tabs: [], activeId: null, splitId: null };
let seq = 0;

function emit() {
  for (const listener of listeners) listener();
}

function set(next: TerminalsState) {
  state = next;
  emit();
}

export function subscribeTerminals(listener: Listener): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getTerminals(): TerminalsState {
  return state;
}

function mint(): TerminalTab {
  seq += 1;
  return {
    id: `term-${seq}-${Math.random().toString(36).slice(2, 8)}`,
    title: IDLE_TERMINAL_TITLE,
  };
}

/**
 * Rust reports the shell's foreground process (`pty:title`). An empty title
 * means the prompt is idle, so the tab goes back to saying "Shell".
 */
export function renameTerminal(id: string, title: string) {
  const next = title.trim() || IDLE_TERMINAL_TITLE;
  const current = state.tabs.find((tab) => tab.id === id);
  // Bail before building anything. Rust polls, so most reports say what we
  // already know — and a new state object for each of those would re-render
  // every pane roughly once a second.
  if (!current || current.title === next) return;
  set({
    ...state,
    tabs: state.tabs.map((tab) => (tab.id === id ? { ...tab, title: next } : tab)),
  });
}

/** The first tab, minted on demand — opening the terminal shouldn't need a
 *  separate "create one" step. Returns the id the primary pane should show. */
export function ensureTerminal(): string {
  if (state.activeId && state.tabs.some((tab) => tab.id === state.activeId)) {
    return state.activeId;
  }
  if (state.tabs.length > 0) {
    const first = state.tabs[0];
    set({ ...state, activeId: first.id });
    return first.id;
  }
  const tab = mint();
  set({ tabs: [tab], activeId: tab.id, splitId: null });
  return tab.id;
}

/** New tab, focused. */
export function addTerminal(): string {
  const tab = mint();
  set({ ...state, tabs: [...state.tabs, tab], activeId: tab.id });
  return tab.id;
}

export function selectTerminal(id: string) {
  if (!state.tabs.some((tab) => tab.id === id)) return;
  // Selecting the split's tab in the strip would leave the same shell in both
  // panes; swap the panes instead, which is what the click means.
  if (id === state.splitId) {
    set({ ...state, activeId: id, splitId: state.activeId });
    return;
  }
  set({ ...state, activeId: id });
}

/** Split on, with a fresh shell beside the current one — or split off. */
export function toggleSplitTerminal() {
  if (state.splitId) {
    const closing = state.splitId;
    set({ ...state, splitId: null });
    closeTerminal(closing);
    return;
  }
  const tab = mint();
  set({ ...state, tabs: [...state.tabs, tab], splitId: tab.id });
}

/**
 * Close a tab and kill its shell. The last tab can go too: the terminal is
 * toggled by the surfaces that host it, so an empty store just means the next
 * open mints a fresh shell.
 */
export function closeTerminal(id: string) {
  const tabs = state.tabs.filter((tab) => tab.id !== id);
  const activeId =
    state.activeId === id
      ? state.splitId && state.splitId !== id
        ? state.splitId
        : tabs[0]?.id ?? null
      : state.activeId;
  set({
    tabs,
    activeId,
    // The split slot can't survive holding a closed tab, nor showing whatever
    // just became primary.
    splitId: state.splitId === id || state.splitId === activeId ? null : state.splitId,
  });
  void invoke("pty_close", { id }).catch(() => {});
}

/** A shell exited on its own (`exit`, or it was killed). Drop the tab. */
export function terminalExited(id: string) {
  if (!state.tabs.some((tab) => tab.id === id)) return;
  const tabs = state.tabs.filter((tab) => tab.id !== id);
  const activeId =
    state.activeId === id
      ? state.splitId && state.splitId !== id
        ? state.splitId
        : tabs[0]?.id ?? null
      : state.activeId;
  set({
    tabs,
    activeId,
    splitId: state.splitId === id || state.splitId === activeId ? null : state.splitId,
  });
}

/** Test seam — module state would otherwise leak between cases. */
export function resetTerminalsForTest() {
  state = { tabs: [], activeId: null, splitId: null };
  seq = 0;
  listeners.clear();
}

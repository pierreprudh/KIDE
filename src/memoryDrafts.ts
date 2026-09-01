// Pending Project Memory drafts awaiting review.
//
// When a Klide run settles "done" (and auto-memory is on), the harness
// generates a structured note but does NOT write it to `.klide/memory/`
// straight away — it parks it here as a draft. The user then accepts, edits,
// or skips it from the Memory modal before it becomes durable. This keeps the
// durable store clean (no half-baked auto-notes) while still capturing the
// session while it's fresh.
//
// Module-level + localStorage-backed (like `tasks.ts`, but persisted) so a
// draft survives a panel close, a view switch, and an app restart — a run
// that finished while you were away is still waiting when you come back.
// Drafts carry their `workspaceRoot` so they stay scoped to the project that
// produced them.

import type { MemoryInput } from "./memory";
import { createPersistedStore } from "./persistedStore";

export type MemoryDraft = MemoryInput & {
  /** Local draft id — distinct from the durable memory entry id. */
  draftId: string;
  createdAtMs: number;
  /** Project this draft belongs to; drafts are shown per-workspace. */
  workspaceRoot: string;
};

const STORAGE_KEY = "klide.memoryDrafts";

const store = createPersistedStore<MemoryDraft[]>({
  key: STORAGE_KEY,
  // Drafts persisted before MemoryInput gained kind/tags/sourceRefs/supersedes
  // still live in localStorage without them; backfill so the type's promise
  // holds at runtime and an accepted legacy draft writes a well-formed entry.
  validate: (parsed) => {
    if (!Array.isArray(parsed)) return [];
    return (parsed as Array<Partial<MemoryDraft> | null>)
      .filter(
        (d): d is Partial<MemoryDraft> =>
          !!d && typeof d === "object" && typeof d.draftId === "string"
      )
      .map(
        (d) =>
          ({
            kind: "handoff",
            tags: [],
            sourceRefs: [],
            supersedes: null,
            ...d,
          }) as MemoryDraft
      );
  },
});

function genId(): string {
  return `draft-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function subscribeMemoryDrafts(fn: () => void): () => void {
  return store.subscribe(fn);
}

// Stable snapshot for useSyncExternalStore — the reference only changes when
// the list actually changes (every mutation replaces the array). Consumers
// filter by workspace in a useMemo to avoid breaking snapshot stability.
export function getMemoryDrafts(): MemoryDraft[] {
  return store.get();
}

export function addMemoryDraft(
  input: MemoryInput,
  workspaceRoot: string
): MemoryDraft {
  const draft: MemoryDraft = {
    ...input,
    draftId: genId(),
    createdAtMs: Date.now(),
    workspaceRoot,
  };
  store.mutate((drafts) => [draft, ...drafts]);
  return draft;
}

export function updateMemoryDraft(draftId: string, patch: Partial<MemoryInput>) {
  store.mutate((drafts) => drafts.map((d) => (d.draftId === draftId ? { ...d, ...patch } : d)));
}

export function removeMemoryDraft(draftId: string) {
  store.mutate((drafts) => drafts.filter((d) => d.draftId !== draftId));
}

import { invoke } from "@tauri-apps/api/core";
import type { ProviderId } from "../../agent/types";
import type { Conversation, Msg } from "./types";
import type { ProjectContextItem } from "../../contextTray";
import { notify as notifyUser } from "../../toast";

export function cssVar(name: string): string {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// Exact token count for a string under a specific model's own tokenizer, where
// the provider exposes one (Ollama /api/tokenize, Anthropic count_tokens);
// otherwise a length-based estimate with `exact: false`. Counts message
// content only — the chat-template wrapper the model also sees is not included,
// so per-message counts won't sum to a full-prompt total.
export async function countMessageTokens(
  provider: string,
  model: string,
  text: string,
): Promise<{ count: number; exact: boolean }> {
  const res = await invoke<{ tokens: number; exact: boolean }>("ai_count_tokens", {
    provider,
    model,
    text,
  });
  return { count: res.tokens, exact: res.exact };
}

export function genId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// The snapshot to persist for a conversation. Right after a send the list is
// `[…, user, assistant("")]` — an empty placeholder waiting for tokens. We
// must not let that placeholder block persistence (a view switch in that
// window would otherwise drop the just-sent user message), so strip a
// trailing empty assistant turn but keep everything before it.
export function messagesForPersist(msgs: Msg[]): Msg[] {
  if (msgs.length === 0) return msgs;
  const last = msgs[msgs.length - 1];
  if (last.role === "assistant" && !last.content && !last.thinking && !last.toolCalls) {
    return msgs.slice(0, -1);
  }
  return msgs;
}

export function deriveTitle(msgs: Msg[]): string {
  const firstUser = msgs.find((m) => m.role === "user");
  const text = firstUser?.content.trim() ?? "";
  if (!text) return "New chat";
  return text.length > 42 ? `${text.slice(0, 42)}…` : text;
}

/** Tokens for a Lens slice. Lived in `contextTray.ts` with its own inline
 *  `/ 3.7`, a second copy of the constant `estimateTokens` owns — on the
 *  auto-compaction path, where a drift arms a paid call at the wrong moment. It
 *  could not simply call across, because `contextTray` is imported *by* this
 *  module; re-homing it here removes the duplicate and the cycle at once. */
export function estimateProjectContextTokens(items: ProjectContextItem[]): number {
  return items.reduce(
    (sum, item) => sum + estimateTokens(`${item.path}\n${item.label}\n${item.detail}`),
    0
  );
}

export function estimateTokens(text: string): number {
  if (!text.trim()) return 0;
  return Math.ceil(text.length / 3.7);
}

export function messageTokenEstimate(m: Msg): number {
  let total = estimateTokens(m.content);
  if (m.role === "user" && m.attachments) {
    total += m.attachments.reduce(
      (sum, a) => sum + estimateTokens(a.path) + estimateTokens(a.content),
      0
    );
  }
  if (m.role === "user" && m.projectContext) {
    total += estimateProjectContextTokens(m.projectContext.items);
  }
  if (m.role === "assistant") {
    total += estimateTokens(m.thinking ?? "");
    total += estimateTokens(JSON.stringify(m.toolCalls ?? []));
  }
  if (m.role === "tool") total += estimateTokens(m.toolName);
  return total;
}


export { formatSpan, relativeTime } from "../../time";


/** The AI panel's `@file` picker and the command palette rank the same way —
 *  see `fileSearch.ts`. They used to have two implementations with the same four
 *  tiers in opposite polarity, so one query gave two orders. */
export { rankFiles as fuzzyFiles, isSubsequence } from "../../fileSearch";


const CONVOS_KEY = "klide-conversations";
export const CONVERSATIONS_CHANGED_EVENT = "klide:conversations-changed";
export type ConversationChangedDetail = {
  conversationId: string;
  provider: ProviderId;
  cwd: string | null;
};
const MAX_CONVERSATIONS = 100;
let conversationStorageFailureNotified = false;
let conversationStoragePressureNotified = false;

function isQuotaExceeded(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { name?: unknown; code?: unknown };
  return (
    value.name === "QuotaExceededError" ||
    value.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
    value.code === 22 ||
    value.code === 1014
  );
}

export function loadConversations<T>(key?: string): T[] {
  try {
    const raw = localStorage.getItem(key ?? CONVOS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(parsed)) return [];
    // Heal malformed records on read. Every consumer assumes `msgs` is an
    // array of message objects and dereferences `m.role` (e.g. deriveTitle's
    // `msgs.find((m) => m.role === "user")`). A partially-written record — a
    // missing `msgs`, or a `null`/non-object slot inside it — would throw at
    // the call site, and since these run during render/mount, blank the whole
    // app (white screen). So we drop entries without a `msgs` array and strip
    // any null/non-object messages from the arrays we keep.
    return parsed
      .filter((c) => c && typeof c === "object" && Array.isArray((c as { msgs?: unknown }).msgs))
      .map((c) => ({
        ...(c as object),
        msgs: ((c as { msgs: unknown[] }).msgs).filter(
          (m) => m && typeof m === "object"
        ),
      })) as T[];
  } catch {
    return [];
  }
}

export function saveConversations<T>(
  list: T[],
  key?: string,
  notify = true,
  detail?: ConversationChangedDetail,
): T[] {
  const storageKey = key ?? CONVOS_KEY;
  let candidate = list;
  while (true) {
    try {
      localStorage.setItem(storageKey, JSON.stringify(candidate));
      const pruned = list.length - candidate.length;
      conversationStorageFailureNotified = false;
      if (pruned > 0 && storageKey === CONVOS_KEY) {
        if (!conversationStoragePressureNotified) {
          notifyUser(
            `Local conversation history was full, so Klide removed ${pruned} older snapshot${pruned === 1 ? "" : "s"}. Durable Run transcripts remain in Mission Control.`,
            { tone: "warn" },
          );
        }
        conversationStoragePressureNotified = true;
      } else {
        conversationStoragePressureNotified = false;
      }
      // The native `storage` event does not fire in the window that performed
      // the write. Focus and AiPanel live in that same window, so publish one
      // lightweight navigation event when the visible conversation index
      // changes (new row, reordered row, title/model/provider/folder update).
      if ((notify || pruned > 0) && storageKey === CONVOS_KEY && typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent(CONVERSATIONS_CHANGED_EVENT, { detail }));
      }
      return candidate;
    } catch (error) {
      // A Conversation snapshot is only the local reader cache; the Harness
      // Transcript remains durable on disk. Under quota pressure, keep the
      // newest contiguous history and retry by removing one oldest snapshot
      // at a time. Never discard the current/newest Conversation itself.
      if (storageKey === CONVOS_KEY && isQuotaExceeded(error) && candidate.length > 1) {
        candidate = candidate.slice(0, -1);
        continue;
      }
      if (!conversationStorageFailureNotified) {
        notifyUser(
          "Klide could not save the local conversation index. The durable Run transcript is still on disk.",
          { tone: "error" },
        );
        conversationStorageFailureNotified = true;
      }
      return loadConversations<T>(storageKey);
    }
  }
}

/** Do these two records hold the same conversation, message for message? */
function sameMessages(a: Msg[] | undefined, b: Msg[] | undefined): boolean {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((message, index) => {
    const other = b[index];
    return message?.role === other?.role && message?.content === other?.content;
  });
}

function conversationIndexChanged(
  conversation: Conversation,
  existing: Conversation[],
): boolean {
  const previousIndex = existing.findIndex((item) => item.id === conversation.id);
  if (previousIndex !== 0) return true;
  const previous = existing[0];
  return (
    !previous ||
    previous.title !== conversation.title ||
    previous.provider !== conversation.provider ||
    previous.model !== conversation.model ||
    previous.cwd !== conversation.cwd ||
    previous.branch !== conversation.branch ||
    previous.worktree !== conversation.worktree
  );
}

/** When the conversation began, epoch ms. Prefers the stored `createdAt`, then
 *  the first message that carries its own timestamp, and finally `updatedAt` —
 *  the last of which is only right for a one-turn thread, but it is the best a
 *  record written before timestamps existed can offer. */
export function conversationStartedAt(conv: Conversation): number {
  if (typeof conv.createdAt === "number") return conv.createdAt;
  const firstStamped = conv.msgs?.find((m) => typeof (m as { ts?: number }).ts === "number");
  return (firstStamped as { ts?: number } | undefined)?.ts ?? conv.updatedAt;
}

/** How long the conversation has been running, ms — start to last activity. */
export function conversationDuration(conv: Conversation): number {
  return Math.max(0, conv.updatedAt - conversationStartedAt(conv));
}

export function upsertConversation(
  conv: Conversation,
  existing: Conversation[] = loadConversations<Conversation>(),
): Conversation[] {
  const previous = existing.find((c) => c.id === conv.id);
  // `updatedAt` is rewritten on every token, so the start has to be carried
  // forward explicitly or the thread loses it on the next save. An existing
  // record's start always wins — a resumed conversation begins when it was
  // first sent, not when it was reopened.
  const createdAt = previous
    ? conversationStartedAt(previous)
    : (conv.createdAt ?? conversationStartedAt(conv));
  // The index is ordered by recency, not by write order — a record that was
  // re-saved without gaining a turn keeps its place instead of jumping the
  // queue. Sorting rather than unshifting also means the prune below drops the
  // genuinely oldest thread. The upserted record leads among equal times, and
  // Array#sort is stable, so it keeps that lead.
  const next = [{ ...conv, createdAt }, ...existing.filter((c) => c.id !== conv.id)];
  next.sort((a, b) => b.updatedAt - a.updatedAt);
  return next.slice(0, MAX_CONVERSATIONS);
}

export function persistConversation(
  conv: Conversation,
  _stalePanelSnapshot?: Conversation[],
): Conversation[] {
  // Every mounted panel has its own React history state. That state is useful
  // for rendering but is not a safe write base: two panels can mount from the
  // same snapshot, then the second writer would erase the first. Re-read the
  // one durable browser store synchronously for every merge. The optional
  // argument remains only so older callers cannot reintroduce last-writer-wins
  // while they migrate; it is intentionally ignored.
  const current = loadConversations<Conversation>();
  // Loading a conversation re-snapshots it verbatim, and the snapshot always
  // carries a fresh `updatedAt`. Letting that land would make reading a thread
  // count as working on it: it would climb to the top of its provider group,
  // drag the group's own sort position with it, and read "just now" though
  // nothing was said. Activity is what changes the messages — so when they are
  // identical to the stored record, keep the time that record already had.
  // Metadata edits (model, branch) still save; they just don't count as use.
  const previous = current.find((item) => item.id === conv.id);
  const stamped =
    previous && sameMessages(previous.msgs, conv.msgs)
      ? { ...conv, updatedAt: previous.updatedAt }
      : conv;
  const next = upsertConversation(stamped, current);
  // Streaming persists on every token. Avoid making Focus rebuild its rail on
  // every text delta; the first snapshot already contains the selected model,
  // so notify only when navigation-visible metadata or ordering changes.
  const navigationChanged = conversationIndexChanged(stamped, current);
  return saveConversations(
    next,
    undefined,
    navigationChanged,
    navigationChanged
      ? {
          conversationId: conv.id,
          provider: conv.provider ?? "ollama",
          cwd: conv.cwd ?? null,
        }
      : undefined,
  );
}

const DELEGATE_PROVIDER_IDS = new Set(["claude-code", "codex", "opencode"]);

function hasRestorableMessages(conv: Conversation): boolean {
  if (!conv || !Array.isArray(conv.msgs)) return false;
  return conv.msgs.some((m) => {
    if (!m || typeof m.content !== "string") return false;
    if (m.role === "user") return m.content.trim().length > 0;
    if (m.role === "assistant") return !m.delegateConsole && m.content.trim().length > 0;
    return false;
  });
}

export function latestRestorableConversationId(
  workspaceRoot: string | null,
  provider?: string | null,
): string | null {
  const conversations = loadConversations<Conversation>()
    .filter((conv) => hasRestorableMessages(conv))
    .filter((conv) => !conv.provider || !DELEGATE_PROVIDER_IDS.has(conv.provider))
    .filter((conv) => !workspaceRoot || !conv.cwd || conv.cwd === workspaceRoot)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const providerMatch = provider
    ? conversations.find((conv) => conv.provider === provider)
    : null;
  return (providerMatch ?? conversations[0])?.id ?? null;
}

// A panel's *conversation* identity is separate from its *panel* identity
// (provider/model prefs, keyed by panelId). We persist a tiny per-panel
// record so a transient unmount (view switch) can re-attach to the Conversation
// the panel was showing. Workspace + Provider prevent a durable Delegate
// binding from leaking into another Workspace. Run activity belongs to
// Conversation Session; it was previously written here as `active` but never
// read, so older records may contain that harmless extra field.
const PANEL_SESSION_PREFIX = "klide.panelSession.";

export interface PanelSession {
  convoId: string;
  workspaceRoot?: string | null;
  provider?: ProviderId;
}

export function loadPanelSession(panelId: string): PanelSession | null {
  try {
    const raw = localStorage.getItem(PANEL_SESSION_PREFIX + panelId);
    if (!raw) return null;
    const p = JSON.parse(raw);
    if (p && typeof p.convoId === "string") {
      return {
        convoId: p.convoId,
        workspaceRoot:
          p.workspaceRoot === null || typeof p.workspaceRoot === "string"
            ? p.workspaceRoot
            : undefined,
        provider: typeof p.provider === "string" ? p.provider as ProviderId : undefined,
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function savePanelSession(panelId: string, session: PanelSession) {
  try {
    localStorage.setItem(
      PANEL_SESSION_PREFIX + panelId,
      JSON.stringify(session)
    );
  } catch {
    /* storage full or unavailable */
  }
}

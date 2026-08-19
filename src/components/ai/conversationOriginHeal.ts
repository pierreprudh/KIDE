// Repair Stored conversations whose Provider metadata was overwritten.
//
// Before `originProvider` existed (conversationSession.ts), a Conversation
// recorded the panel's *current* dispatch target rather than what produced its
// turns: moving the picker rewrote the thread's provider and model on the next
// save. A panel could also restore a thread belonging to another Provider
// entirely, which made that rewrite easy to trigger without noticing — a
// Claude Code thread would surface in history, and on the Mission Control
// board, labelled OpenRouter.
//
// Both causes are fixed going forward. This heals the records already on disk.
//
// The only surviving evidence is `Msg.delegateProvider`: every delegate turn
// stamps the CLI's display name onto its assistant message, console or
// headless. So a thread whose FIRST assistant turn names a delegate began on
// that delegate, whatever its metadata now claims.
//
// Deliberately narrow: only the first assistant turn counts. A thread that
// started on an API provider and later moved to a CLI has a delegate name
// further down, but its origin is the API provider — and since a non-delegate
// turn stamps nothing, that origin is unrecoverable, so such a record is left
// exactly as it is. Guessing there would trade one wrong label for another.

import type { Conversation, Msg } from "./types";
import { delegateProviderByName, isDelegateProvider } from "../../agent/providers";
import { loadConversations, saveConversations } from "./storedConversations";

/** The delegate a thread demonstrably began on, or null when its first
 *  assistant turn didn't come from one (or came from a CLI this build can no
 *  longer name). */
export function originDelegateOf(msgs: Msg[]): string | null {
  const firstAssistant = msgs.find((m) => m && m.role === "assistant");
  if (!firstAssistant || firstAssistant.role !== "assistant") return null;
  const name = firstAssistant.delegateProvider;
  return name ? delegateProviderByName(name) : null;
}

/**
 * The corrected record, or null when nothing needs correcting.
 *
 * The model is dropped rather than kept: a record mislabelled OpenRouter
 * carries OpenRouter's model, which belongs to no turn in the thread and
 * cannot be recovered. An unknown model reads as "unknown" everywhere it
 * surfaces; a confidently wrong one does not.
 */
export function healedConversationOrigin(conv: Conversation): Conversation | null {
  // A record already on a delegate is either right or unrecoverable; either
  // way this heal has nothing to add.
  if (conv.provider && isDelegateProvider(conv.provider)) return null;
  const origin = originDelegateOf(conv.msgs);
  if (!origin || origin === conv.provider) return null;
  return { ...conv, provider: origin as Conversation["provider"], model: null };
}

/**
 * Heal the whole Stored conversation index in place. Runs at boot, before any
 * surface reads it.
 *
 * Idempotent and unflagged on purpose: it is a pure function of the data, so a
 * second run changes nothing, and a record whose custom CLI wasn't loaded yet
 * on this boot still gets its chance on the next one. `updatedAt` is untouched
 * — repairing a label is not activity, and Focus orders its rail by that time.
 *
 * Mission Control needs no separate pass: its store overlays the Stored
 * conversations over its own rows on first read each session, so a healed
 * thread re-derives its board row from the corrected record.
 */
export function healStoredConversationOrigins(): number {
  let healed = 0;
  const conversations = loadConversations<Conversation>();
  const next = conversations.map((conv) => {
    const fixed = healedConversationOrigin(conv);
    if (!fixed) return conv;
    healed += 1;
    return fixed;
  });
  // Don't rewrite (or notify) an index that was already correct.
  if (healed > 0) saveConversations(next, undefined, false);
  return healed;
}

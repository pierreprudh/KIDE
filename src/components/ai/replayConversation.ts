// Rebuild an AI-panel Conversation from a Transcript on disk.
//
// The file used to be named `eventsToMsgs`, after its most trivial export — a
// three-line composition of `foldAgentEvents` + `foldedToMsgs`. The load-bearing
// part is `eventsToConversation`, which is not a parser at all: `foldEvents.ts`
// owns the wire format, and this is the *replay decoration* on top of it —
// which system lines a resumed panel needs in order to explain itself.
//
// That decoration has to agree with the live run path in AiPanel, and the rule
// they share is `IS_SILENT_RUN_ERROR`.

import type { AgentEvent } from "../../agent/types";
import { foldAgentEvents, foldedToMsgs } from "../../agent/foldEvents";
import type { Conversation, Msg } from "./types";

/**
 * A user-initiated Stop is not a failure, so it gets no error line — the
 * partial output is the answer.
 *
 * Exported because the live path in AiPanel makes the same judgement, and the
 * two must agree: if replay surfaced an abort that the live view swallowed, the
 * same run would read as failed after a reload and fine before it.
 */
export const SILENT_RUN_ERROR_CODE = "aborted";

export function isSilentRunError(code: string): boolean {
  return code === SILENT_RUN_ERROR_CODE;
}

type RunMeta = {
  mode: "chat" | "plan" | "goal";
  provider: string;
  model: string;
};

/** Run metadata from the `run_started` event, which is always first. */
function extractRunMeta(events: AgentEvent[]): RunMeta | null {
  const first = events[0];
  if (first?.type === "run_started") {
    return { mode: first.mode, provider: first.provider, model: first.model };
  }
  return null;
}

/** Convert a full Klide agent transcript into AiPanel-compatible messages. */
export function eventsToMsgs(events: AgentEvent[]): Msg[] {
  return foldedToMsgs(foldAgentEvents(events));
}

/**
 * The replay a live panel should adopt over what it currently shows.
 *
 * Two paths need this and must agree: the mount reconnect (`followConversationRun`)
 * and the post-turn heal that runs when a turn stopped reaching the screen.
 * Both add back the turns queued locally — a queued turn was typed ahead and
 * has not been sent, so the Transcript cannot know about it — and both refuse a
 * replay that is *shorter* than what is on screen, which is how a half-written
 * or truncated read is kept from eating live rows.
 *
 * Returns null when the replay has nothing to add.
 */
export function replayForAdoption(
  events: AgentEvent[],
  current: Msg[],
): Msg[] | null {
  const queuedLocal = current.filter(
    (m) => m.role === "user" && m.queueState === "queued",
  );
  const replayed = [...eventsToMsgs(events), ...queuedLocal];
  return replayed.length >= current.length ? replayed : null;
}

/** Reconstruct a Conversation from events for AiPanel resumption. */
export function eventsToConversation(
  events: AgentEvent[],
  runId: string,
  title: string,
): Conversation {
  const meta = extractRunMeta(events);
  const msgs = eventsToMsgs(events);

  if (meta) {
    msgs.unshift({
      role: "system",
      content: `Run: ${meta.mode} · ${meta.provider}/${meta.model}`,
    });
  }

  // A run that ended in failure (e.g. the provider returned a 500) has no
  // assistant turn to fold, so a resumed panel would otherwise show the user
  // message and nothing else — reading as an empty or hung run. Surface the
  // error as a trailing system line so the resumed view explains itself.
  // A user-initiated Stop is intentionally silent — same rule as the live run
  // path in AiPanel, shared as `isSilentRunError` so they cannot diverge.
  const runError = events.find(
    (e): e is Extract<AgentEvent, { type: "run_error" }> =>
      e.type === "run_error" && !isSilentRunError(e.error.code),
  );
  if (runError) {
    msgs.push({
      role: "system",
      content: `Run failed: ${runError.error.message}`,
    });
  }

  // A transcript knows exactly when it started and when it last moved — take
  // both from the events rather than stamping "now" on a run that may have
  // finished days ago.
  const first = events[0];
  const last = events[events.length - 1];
  return {
    id: runId,
    title,
    msgs,
    updatedAt: typeof last?.ts === "number" ? last.ts : Date.now(),
    createdAt: typeof first?.ts === "number" ? first.ts : undefined,
  };
}

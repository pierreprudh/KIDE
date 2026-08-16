// Which conversations have a live Harness Run right now.
//
// The rail lists threads you have walked away from, and walking away does not
// stop a run — the loop lives in Rust and keeps writing its transcript while
// the panel is unmounted. So a rail row needs to say "this one is still going"
// without the panel being there to say it.
//
// The obvious source is wrong on its own. AiPanel publishes `status: "running"`
// to the Mission Control store while it streams, but that publisher is
// mount-tied: leave mid-run and the last thing it wrote stays "running" in
// localStorage forever, even after the harness settles. So the store only
// *nominates* candidates — Rust is asked for the truth (`agent_run_status`),
// and each confirmed run is then followed on its global `agent-run:{id}`
// stream until it emits a terminal event. Nothing polls.
//
// One watcher set is shared by every subscriber: rows ask about their own id,
// not for the whole set, so a rail of forty conversations still runs one
// reconcile pass.

import { useSyncExternalStore } from "react";
import { getKlideConvos, subscribeKlideConvos } from "./klideConvos";
import {
  getAgentRunStatus,
  isActiveRunStatus,
  reattachAgentRun,
  type RunReattachment,
} from "./agent/client";

const listeners = new Set<() => void>();
/** Confirmed-live run ids. Replaced (never mutated) so snapshots stay stable. */
let runningIds: ReadonlySet<string> = new Set();
/** Runs we are following to their terminal event. */
const watched = new Map<string, RunReattachment>();
/** Ids with a confirmation in flight — two reconciles must not both attach. */
const confirming = new Set<string>();
let started = false;

function emit(next: ReadonlySet<string>) {
  runningIds = next;
  for (const fn of listeners) fn();
}

function markRunning(id: string) {
  if (runningIds.has(id)) return;
  const next = new Set(runningIds);
  next.add(id);
  emit(next);
}

function markSettled(id: string) {
  watched.get(id)?.detach();
  watched.delete(id);
  if (!runningIds.has(id)) return;
  const next = new Set(runningIds);
  next.delete(id);
  emit(next);
}

async function confirmAndFollow(id: string) {
  if (watched.has(id) || confirming.has(id)) return;
  confirming.add(id);
  try {
    // Delegate conversations are PTY-driven and have no Harness Run, so the
    // supervisor answers null for them — same as a settled run it has evicted.
    const status = await getAgentRunStatus(id).catch(() => null);
    if (!isActiveRunStatus(status)) return;
    // `fromSeq: 0` — we want the terminal event, not a replay; the payload is
    // ignored, only `done` matters.
    const watch = await reattachAgentRun(id, 0, () => {});
    if (watched.has(id)) {
      watch.detach();
      return;
    }
    watched.set(id, watch);
    markRunning(id);
    void watch.done.then(() => markSettled(id));
  } finally {
    confirming.delete(id);
  }
}

function reconcile() {
  const candidates = new Set(
    getKlideConvos()
      .filter((c) => c.status === "running")
      .map((c) => c.id),
  );
  // A conversation the store no longer calls running (its panel came back and
  // settled it) or that was deleted outright: drop the watch rather than wait
  // for an event that may never arrive.
  for (const id of watched.keys()) {
    if (!candidates.has(id)) markSettled(id);
  }
  for (const id of candidates) void confirmAndFollow(id);
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn);
  if (!started) {
    started = true;
    subscribeKlideConvos(reconcile);
    reconcile();
  }
  return () => {
    listeners.delete(fn);
  };
}

/** Subscribe to the confirmed-live set. Starts the watcher on first call. */
export function subscribeRunningConversations(fn: () => void): () => void {
  return subscribe(fn);
}

/** The confirmed-live run ids, as of now. */
export function getRunningConversationIds(): ReadonlySet<string> {
  return runningIds;
}

/** Does this conversation have a run going in Rust right now? */
export function useIsConversationRunning(conversationId: string): boolean {
  return useSyncExternalStore(
    subscribe,
    () => runningIds.has(conversationId),
    () => false,
  );
}

/** Test seam — drops every watcher and forgets what was running. */
export function resetRunningConversations(): void {
  for (const id of [...watched.keys()]) markSettled(id);
  confirming.clear();
  emit(new Set());
}

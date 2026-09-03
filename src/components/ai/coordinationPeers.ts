// Who a conversation is talking to, and what to call them.
//
// Agent-to-agent traffic travels on Run ids, and a Run id is also the id of
// the conversation that owns it (see runs.ts). The stored conversation index
// already holds a human title, a provider and a model for every thread in
// this app, so the chat can say "Asked @Fix the parser" and draw the other
// thread's model mark instead of "Asked @7f3a9c…". Runs with no stored thread
// — a subagent, a Delegate — fall back to a shortened id and no mark.
//
// The receiving side is recorded in the transcript as a steering marker whose
// reason the harness writes in one fixed shape
// ("Agent message delivered: question from @run_x (env_1); …"). Parsing that
// line here is what lets the panel show an inbox row instead of a generic
// "Steered" line, and fetch the message bodies from the journal on demand.

import { useEffect, useState } from "react";
import type { ProviderId } from "../../agent/types";
import type { Conversation, Msg } from "./types";
import { CONVERSATIONS_CHANGED_EVENT, loadConversations } from "./storedConversations";

export const COORDINATION_TOOL_NAMES = new Set([
  "agent_list",
  "agent_send",
  "agent_wait",
  "agent_cancel",
  "agent_read_result",
]);

export type DeliveredEnvelopeRef = {
  kind: string;
  /** `"operator"`, or the sender's Run id. */
  from: string;
  envelopeId: string;
};

const DELIVERY_REASON = /^Agent messages? delivered: (.+)$/;
const DELIVERY_PART = /^(\w+) from (?:@(\S+)|(operator)) \((\S+)\)$/;

/** Mirrors `coordination_delivery_reason` in agent/mod.rs. `null` when the
 *  reason is any other steering line. */
export function parseDeliveryReason(reason: string): DeliveredEnvelopeRef[] | null {
  const match = DELIVERY_REASON.exec(reason.trim());
  if (!match) return null;
  const refs: DeliveredEnvelopeRef[] = [];
  for (const part of match[1].split("; ")) {
    const m = DELIVERY_PART.exec(part.trim());
    if (!m) continue;
    refs.push({ kind: m[1], from: m[2] ?? "operator", envelopeId: m[4] });
  }
  return refs.length > 0 ? refs : null;
}

export function shortRunId(runId: string): string {
  if (runId.length <= 20) return runId;
  return `${runId.slice(0, 8)}…${runId.slice(-6)}`;
}

/** What the stored index knows about a peer thread. */
export type PeerInfo = {
  title: string;
  provider: ProviderId | null;
  model: string | null;
};

export type PeerIndex = Map<string, PeerInfo>;

/** Peer threads by conversation id, from the stored index. Cheap enough to
 *  rebuild on every change event; the index is small and already in memory. */
export function peerIndex(): PeerIndex {
  const index: PeerIndex = new Map();
  for (const conv of loadConversations<Conversation>()) {
    if (!conv.id || !conv.title) continue;
    index.set(conv.id, {
      title: conv.title,
      provider: conv.provider ?? null,
      model: conv.model ?? null,
    });
  }
  return index;
}

export function peerName(runId: string, index: PeerIndex): string {
  if (runId === "operator") return "operator";
  const title = index.get(runId)?.title.replace(/\s+/g, " ").trim();
  if (!title) return shortRunId(runId);
  return title.length > 40 ? `${title.slice(0, 39)}…` : title;
}

export function usePeerIndex(): PeerIndex {
  const [index, setIndex] = useState<PeerIndex>(() => peerIndex());
  useEffect(() => {
    const refresh = () => setIndex(peerIndex());
    window.addEventListener(CONVERSATIONS_CHANGED_EVENT, refresh);
    return () => window.removeEventListener(CONVERSATIONS_CHANGED_EVENT, refresh);
  }, []);
  return index;
}

function stringArg(args: unknown, key: string): string | null {
  if (!args || typeof args !== "object" || Array.isArray(args)) return null;
  const value = (args as Record<string, unknown>)[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

/** Distinct Run ids this conversation has exchanged messages with, in first-
 *  contact order — the sender side from its own `agent_*` calls, the receiver
 *  side from delivery markers. The operator is not a peer. */
export function coordinationPeersOf(msgs: Msg[]): string[] {
  const peers: string[] = [];
  const add = (id: string | null) => {
    if (id && id !== "operator" && !peers.includes(id)) peers.push(id);
  };
  for (const m of msgs) {
    if (m.role === "assistant") {
      for (const call of m.toolCalls ?? []) {
        if (!COORDINATION_TOOL_NAMES.has(call.name)) continue;
        add(stringArg(call.args, "toRunId"));
        add(stringArg(call.args, "fromRunId"));
        if (call.name !== "agent_list") add(stringArg(call.args, "runId"));
      }
    } else if (m.role === "system" && m.steering) {
      for (const ref of parseDeliveryReason(m.steering.reason) ?? []) add(ref.from);
    }
  }
  return peers;
}

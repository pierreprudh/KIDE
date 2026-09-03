// The link between two conversations that talk to each other, sitting at the
// right end of the conversation-status line (branch · Goal policy · this):
// this thread's model mark, a short hairline, the peer's model mark and its
// title. While this thread is talking, a single dot travels the line — out to
// the peer first, then back. At rest the line is still. One motion, no badge.
import type { ReactNode } from "react";
import type { ProviderId } from "../../agent/types";
import { conversationMark } from "../../modelIdentity";
import { AgentMark } from "../fileMarks";
import { peerName, type PeerIndex } from "./coordinationPeers";

const MARK = 14;

function markFor(model: string | null | undefined, provider: ProviderId | null | undefined): { node: ReactNode; label: string } {
  // The harness chat wears Klide's own mark when the runner is unknown — a
  // subagent, or a thread saved before its provider was recorded.
  return conversationMark(model, provider, MARK) ?? { node: <AgentMark size={11} />, label: "Klide agent" };
}

export function PeerLink({
  peers,
  index,
  provider,
  model,
  active,
}: {
  /** Run ids this thread has exchanged messages with. */
  peers: string[];
  index: PeerIndex;
  /** This thread's own runner. */
  provider: ProviderId;
  model: string | null | undefined;
  /** True while this thread is streaming — the only time the dot moves. */
  active: boolean;
}) {
  if (peers.length === 0) return null;
  const mine = markFor(model, provider);
  return (
    <div className="ai-msg-in" style={{ display: "flex", alignItems: "center", gap: 14, marginLeft: "auto", minWidth: 0, flex: "0 1 auto" }}>
      {peers.map((id) => {
        const info = index.get(id);
        const theirs = markFor(info?.model, info?.provider);
        return (
          <div key={id} style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0 }}>
            <span title={mine.label} style={{ display: "grid", placeItems: "center", width: MARK, height: MARK, flexShrink: 0 }}>{mine.node}</span>
            <span aria-hidden style={{ position: "relative", width: 44, flexShrink: 0, height: 1, background: "color-mix(in srgb, var(--border-strong) 55%, transparent)" }}>
              {active && <span className="ai-peer-dot" />}
            </span>
            <span title={theirs.label} style={{ display: "grid", placeItems: "center", width: MARK, height: MARK, flexShrink: 0 }}>{theirs.node}</span>
            <span title={id} style={{ fontFamily: "var(--font-ui)", fontSize: 10.5, color: "var(--fg-subtle)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, maxWidth: 200 }}>
              {peerName(id, index)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

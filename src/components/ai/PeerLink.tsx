// The link between two conversations that talk to each other, drawn at the top
// of a thread: this thread's model mark, a hairline, the peer's model mark and
// its title. While this thread is talking, a single dot travels the line — out
// toward the peer when we last sent, back toward us when a peer's message last
// landed. At rest the line is still. One motion, one direction, no badge.
import type { ReactNode } from "react";
import type { ProviderId } from "../../agent/types";
import { conversationMark } from "../../modelIdentity";
import { AgentMark } from "../fileMarks";
import { peerName, type PeerIndex } from "./coordinationPeers";

const MARK = 16;

function markFor(model: string | null | undefined, provider: ProviderId | null | undefined): { node: ReactNode; label: string } {
  // The harness chat wears Klide's own mark when the runner is unknown — a
  // subagent, or a thread saved before its provider was recorded.
  return conversationMark(model, provider, MARK) ?? { node: <AgentMark size={12} />, label: "Klide agent" };
}

export function PeerLink({
  peers,
  index,
  provider,
  model,
  direction,
  active,
}: {
  /** Run ids this thread has exchanged messages with. */
  peers: string[];
  index: PeerIndex;
  /** This thread's own runner. */
  provider: ProviderId;
  model: string | null | undefined;
  direction: "out" | "in" | null;
  /** True while this thread is streaming — the only time the dot moves. */
  active: boolean;
}) {
  if (peers.length === 0) return null;
  const mine = markFor(model, provider);
  return (
    <div className="ai-msg-in" style={{ display: "grid", gap: 6, margin: "0 0 14px" }}>
      {peers.map((id) => {
        const info = index.get(id);
        const theirs = markFor(info?.model, info?.provider);
        return (
          <div key={id} style={{ display: "flex", alignItems: "center", gap: 10, minWidth: 0, height: MARK + 4 }}>
            <span title={mine.label} style={{ display: "grid", placeItems: "center", width: MARK, height: MARK, flexShrink: 0 }}>{mine.node}</span>
            <span aria-hidden style={{ position: "relative", flex: "1 1 40px", minWidth: 40, height: 1, background: "color-mix(in srgb, var(--border) 82%, transparent)" }}>
              {active && direction && <span className="ai-peer-dot" data-direction={direction} />}
            </span>
            <span title={theirs.label} style={{ display: "grid", placeItems: "center", width: MARK, height: MARK, flexShrink: 0 }}>{theirs.node}</span>
            <span title={id} style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--accent)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, flex: "0 1 auto" }}>
              @{peerName(id, index)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

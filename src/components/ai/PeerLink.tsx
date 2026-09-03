// The link between two conversations that talk to each other, drawn under the
// composer, flush right: this thread's model mark, a short hairline, the peer's
// model mark and its title. While this thread is talking, a single dot travels
// the line — out to the peer first, then back. At rest the line is still. One
// motion, no badge.
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
    <div className="ai-msg-in" style={{ display: "grid", gap: 4, justifyItems: "end", padding: "8px 4px 0" }}>
      {peers.map((id) => {
        const info = index.get(id);
        const theirs = markFor(info?.model, info?.provider);
        return (
          <div key={id} style={{ display: "flex", alignItems: "center", gap: 8, minWidth: 0, maxWidth: "100%", height: MARK + 2 }}>
            <span title={mine.label} style={{ display: "grid", placeItems: "center", width: MARK, height: MARK, flexShrink: 0 }}>{mine.node}</span>
            <span aria-hidden style={{ position: "relative", width: 56, flexShrink: 0, height: 1, background: "color-mix(in srgb, var(--border-strong) 55%, transparent)" }}>
              {active && <span className="ai-peer-dot" />}
            </span>
            <span title={theirs.label} style={{ display: "grid", placeItems: "center", width: MARK, height: MARK, flexShrink: 0 }}>{theirs.node}</span>
            <span title={id} style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: "var(--fg-subtle)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", minWidth: 0, maxWidth: 260 }}>
              {peerName(id, index)}
            </span>
          </div>
        );
      })}
    </div>
  );
}

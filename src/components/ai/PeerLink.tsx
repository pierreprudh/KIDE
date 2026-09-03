// The link between two conversations that talk to each other, at the right
// end of the conversation-status line (branch · Goal policy · this): this
// thread's model mark, a short hairline, the peer's model mark. Nothing else
// at rest — the marks say who. While this thread is talking, one small parcel
// travels the line, out to the peer first, then back. Click the link for the
// rest: the peer's title, both runners, and how much has moved each way.
import { createPortal } from "react-dom";
import type { ReactNode } from "react";
import type { ProviderId } from "../../agent/types";
import { conversationMark } from "../../modelIdentity";
import { usePortalMenu } from "../../hooks/usePortalMenu";
import { Z } from "../../zLayers";
import { AgentMark } from "../fileMarks";
import { peerName, type ExchangeStats, type PeerIndex } from "./coordinationPeers";

const MARK = 14;
const TRACK = 44;
const CARD_WIDTH = 240;

function markFor(model: string | null | undefined, provider: ProviderId | null | undefined): { node: ReactNode; label: string } {
  // The harness chat wears Klide's own mark when the runner is unknown — a
  // subagent, or a thread saved before its provider was recorded.
  return conversationMark(model, provider, MARK) ?? { node: <AgentMark size={11} />, label: "Klide agent" };
}

function count(n: number, word: string): string {
  return `${n} ${word}`;
}

function PeerLinkItem({
  id,
  index,
  stats,
  mine,
  active,
}: {
  id: string;
  index: PeerIndex;
  stats?: ExchangeStats;
  mine: { node: ReactNode; label: string };
  active: boolean;
}) {
  const info = index.get(id);
  const theirs = markFor(info?.model, info?.provider);
  const name = peerName(id, index);
  const { open, pos, triggerRef, menuRef, openMenu, close } = usePortalMenu<{ left: number; bottom: number }>({
    computePos: (rect) => ({
      // Above the trigger, right edges aligned, clamped to the viewport.
      bottom: Math.round(window.innerHeight - rect.top + 8),
      left: Math.round(Math.min(Math.max(8, rect.right - CARD_WIDTH), window.innerWidth - CARD_WIDTH - 8)),
    }),
    closeOnOutsideClick: true,
  });
  const sent = stats?.sent ?? 0;
  const received = stats?.received ?? 0;

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? close() : openMenu())}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label={`Talking with ${name}`}
        title={`Talking with ${name}`}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          height: 22,
          padding: "0 4px",
          border: "1px solid transparent",
          borderRadius: 999,
          background: open ? "var(--bg-hover)" : "transparent",
          color: "inherit",
          cursor: "pointer",
          transition: "background var(--motion-fast) var(--ease-out)",
        }}
        onMouseEnter={(e) => { e.currentTarget.style.background = "var(--bg-hover)"; }}
        onMouseLeave={(e) => { e.currentTarget.style.background = open ? "var(--bg-hover)" : "transparent"; }}
      >
        <span aria-hidden style={{ display: "grid", placeItems: "center", width: MARK, height: MARK, flexShrink: 0 }}>{mine.node}</span>
        <span
          aria-hidden
          style={{
            position: "relative",
            width: TRACK,
            flexShrink: 0,
            height: 1,
            background: "color-mix(in srgb, var(--border-strong) 55%, transparent)",
            ["--track" as string]: `${TRACK}px`,
          }}
        >
          {active && <span className="ai-peer-dot" />}
        </span>
        <span aria-hidden style={{ display: "grid", placeItems: "center", width: MARK, height: MARK, flexShrink: 0 }}>{theirs.node}</span>
      </button>
      {open && pos && createPortal(
        <div
          ref={menuRef}
          role="dialog"
          aria-label={`Talking with ${name}`}
          className="popover-enter"
          style={{
            position: "fixed",
            left: pos.left,
            bottom: pos.bottom,
            width: CARD_WIDTH,
            padding: "10px 12px 11px",
            borderRadius: "var(--radius-md)",
            border: "1px solid var(--border-strong)",
            background: "var(--bg-elevated)",
            boxShadow: "0 10px 26px rgba(38, 38, 32, 0.14)",
            zIndex: Z.popover + 5,
            display: "grid",
            gap: 8,
            color: "var(--fg)",
          }}
        >
          <div style={{ fontSize: 12.5, lineHeight: 1.4, color: "var(--fg-strong)", overflowWrap: "anywhere" }}>
            {info?.title ?? name}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 11, color: "var(--fg-subtle)", minWidth: 0 }}>
            <span style={{ display: "grid", placeItems: "center", width: MARK, height: MARK, flexShrink: 0 }}>{mine.node}</span>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{mine.label}</span>
            <span aria-hidden style={{ flex: 1, height: 1, minWidth: 12, background: "color-mix(in srgb, var(--border-strong) 55%, transparent)" }} />
            <span style={{ display: "grid", placeItems: "center", width: MARK, height: MARK, flexShrink: 0 }}>{theirs.node}</span>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{theirs.label}</span>
          </div>
          <div style={{ display: "flex", justifyContent: "space-between", gap: 10, fontSize: 11, color: "var(--fg-subtle)", fontVariantNumeric: "tabular-nums" }}>
            <span>{count(sent, sent === 1 ? "message sent" : "messages sent")}</span>
            <span>{count(received, "received")}</span>
          </div>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--fg-dim)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={id}>
            {id}
          </div>
        </div>,
        document.body,
      )}
    </>
  );
}

export function PeerLink({
  peers,
  index,
  stats,
  provider,
  model,
  active,
}: {
  /** Run ids this thread has exchanged messages with. */
  peers: string[];
  index: PeerIndex;
  stats?: Map<string, ExchangeStats>;
  /** This thread's own runner. */
  provider: ProviderId;
  model: string | null | undefined;
  /** True while this thread is streaming — the only time the parcel moves. */
  active: boolean;
}) {
  if (peers.length === 0) return null;
  const mine = markFor(model, provider);
  return (
    <div className="ai-msg-in" style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: "auto", minWidth: 0, flex: "0 0 auto" }}>
      {peers.map((id) => (
        <PeerLinkItem key={id} id={id} index={index} stats={stats?.get(id)} mine={mine} active={active} />
      ))}
    </div>
  );
}

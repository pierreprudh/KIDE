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
const CARD_WIDTH = 200;

function markFor(model: string | null | undefined, provider: ProviderId | null | undefined): { node: ReactNode; label: string } {
  // The harness chat wears Klide's own mark when the runner is unknown — a
  // subagent, or a thread saved before its provider was recorded.
  return conversationMark(model, provider, MARK) ?? { node: <AgentMark size={11} />, label: "Klide agent" };
}

function PeerLinkItem({
  id,
  index,
  stats,
  mine,
  active,
  onOpen,
}: {
  id: string;
  index: PeerIndex;
  stats?: ExchangeStats;
  mine: { node: ReactNode; label: string };
  active: boolean;
  onOpen?: (id: string) => void;
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
            padding: "8px 10px 9px",
            borderRadius: "var(--radius-md)",
            border: "1px solid var(--border-strong)",
            background: "var(--bg-elevated)",
            boxShadow: "0 10px 26px rgba(38, 38, 32, 0.14)",
            zIndex: Z.popover + 5,
            display: "grid",
            gap: 6,
            color: "var(--fg)",
          }}
        >
          {/* The peer thread is a link: open (or raise) it in its panel. This
              thread needs none — the card is already in it. */}
          <button
            type="button"
            disabled={!onOpen}
            onClick={() => { onOpen?.(id); close(); }}
            title={onOpen ? `Open ${info?.title ?? name}` : id}
            style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0, padding: 0, border: 0, background: "transparent", color: "var(--fg-strong)", font: "inherit", fontSize: 12, lineHeight: 1.35, textAlign: "left", cursor: onOpen ? "pointer" : "default" }}
            onMouseEnter={(e) => { if (onOpen) e.currentTarget.style.color = "var(--accent)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--fg-strong)"; }}
          >
            <span style={{ display: "grid", placeItems: "center", width: MARK, height: MARK, flexShrink: 0 }} title={theirs.label}>{theirs.node}</span>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{info?.title ?? name}</span>
          </button>
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10.5, color: "var(--fg-subtle)", minWidth: 0 }}>
            <span style={{ display: "grid", placeItems: "center", width: MARK, height: MARK, flexShrink: 0 }} title={mine.label}>{mine.node}</span>
            <span aria-hidden style={{ flex: 1, height: 1, background: "color-mix(in srgb, var(--border-strong) 55%, transparent)" }} />
            <span style={{ fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap" }}>
              {sent} sent · {received} received
            </span>
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
  onOpen,
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
  /** Open (or raise) the peer conversation; the card's title is the link. */
  onOpen?: (id: string) => void;
}) {
  if (peers.length === 0) return null;
  const mine = markFor(model, provider);
  return (
    <div className="ai-msg-in" style={{ display: "flex", alignItems: "center", gap: 6, marginLeft: "auto", minWidth: 0, flex: "0 0 auto" }}>
      {peers.map((id) => (
        <PeerLinkItem key={id} id={id} index={index} stats={stats?.get(id)} mine={mine} active={active} onOpen={onOpen} />
      ))}
    </div>
  );
}

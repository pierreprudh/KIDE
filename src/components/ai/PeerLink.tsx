// The link between two conversations that talk to each other, at the right
// end of the conversation-status line (branch · Goal policy · this): this
// thread's model mark, a short hairline, the peer's model mark. Nothing else
// at rest — the marks say who. While this thread is talking, one small parcel
// travels the line, out to the peer first, then back. Click the link to see
// the two conversations by name — the peer's row opens that thread.
import { createPortal } from "react-dom";
import { useState, type ReactNode } from "react";
import type { ProviderId } from "../../agent/types";
import { readCoordinationSnapshot, type CoordinationEnvelope, type CoordinationEnvelopeSnapshot } from "../../agent/coordination";
import { relativeTime } from "../../time";
import { conversationMark } from "../../modelIdentity";
import { usePortalMenu } from "../../hooks/usePortalMenu";
import { Z } from "../../zLayers";
import { AgentMark } from "../fileMarks";
import { peerName, type PeerIndex } from "./coordinationPeers";

const MARK = 14;
const TRACK = 44;
const CARD_WIDTH = 240;

function markFor(model: string | null | undefined, provider: ProviderId | null | undefined): { node: ReactNode; label: string } {
  // The harness chat wears Klide's own mark when the runner is unknown — a
  // subagent, or a thread saved before its provider was recorded.
  return conversationMark(model, provider, MARK) ?? { node: <AgentMark size={11} />, label: "Klide agent" };
}

/** The envelopes that travelled between exactly these two conversations, in
 *  the order they were written, with their delivery state. Self-talk (a thread
 *  messaging itself) matches on both sides and is listed once. */
export function exchangeBetween(
  entries: CoordinationEnvelopeSnapshot[],
  selfId: string,
  peerId: string,
): CoordinationEnvelopeSnapshot[] {
  const between = (from: string, to: string) => (e: CoordinationEnvelope) =>
    e.from.type === "run" && e.from.runId === from && e.toRunId === to;
  return entries
    .filter(({ envelope }) => between(selfId, peerId)(envelope) || between(peerId, selfId)(envelope))
    .sort((a, b) => a.envelope.createdAtMs - b.envelope.createdAtMs);
}

/** One message of the exchange: sender's mark, the kind, and the time or
 *  delivery state. Hover the row and the kind gives way to the sentence
 *  itself, on the same line — the card shows the shape of the exchange at
 *  rest and its words only where the pointer is. */
function ExchangeRow({
  envelope: e,
  sender,
  fromSelf,
  reply,
  pending,
}: {
  envelope: CoordinationEnvelope;
  sender: { node: ReactNode; label: string };
  fromSelf: boolean;
  /** Sits one step under the message it answers. */
  reply: boolean;
  /** "waiting" or "shown" until the message is read; null once it is. */
  pending: string | null;
}) {
  const [hover, setHover] = useState(false);
  return (
    <div
      onMouseEnter={() => setHover(true)}
      onMouseLeave={() => setHover(false)}
      style={{
        display: "grid",
        gridTemplateColumns: `${MARK}px minmax(0, 1fr) auto`,
        columnGap: 6,
        alignItems: "center",
        minWidth: 0,
        height: MARK + 2,
        paddingLeft: reply ? MARK - 2 : 0,
        fontSize: 11,
        lineHeight: 1.3,
      }}
    >
      <span style={{ display: "grid", placeItems: "center", width: MARK, height: MARK, flexShrink: 0 }} title={sender.label}>{sender.node}</span>
      {/* Kind and body share the cell; the pointer cross-fades between them.
          A plain fade — any drift read as the line jumping. */}
      <span style={{ position: "relative", minWidth: 0, height: "1.3em", color: fromSelf ? "var(--fg-subtle)" : "var(--fg)" }}>
        {[
          { text: e.kind, shown: !hover },
          { text: e.body, shown: hover },
        ].map(({ text, shown }) => (
          <span
            key={text === e.kind ? "kind" : "body"}
            aria-hidden={!shown}
            style={{
              position: "absolute",
              inset: 0,
              whiteSpace: "nowrap",
              overflow: "hidden",
              textOverflow: "ellipsis",
              // The kind is the quiet resting state; the sentence arrives at
              // full strength.
              opacity: !shown ? 0 : text === e.kind ? 0.55 : 1,
              transition: "opacity var(--motion-slower) var(--ease-out)",
            }}
          >
            {text}
          </span>
        ))}
      </span>
      <span style={{ color: pending ? "var(--fg-subtle)" : "var(--fg-dim)", whiteSpace: "nowrap", fontVariantNumeric: "tabular-nums" }}>{pending ?? relativeTime(e.createdAtMs)}</span>
    </div>
  );
}

function PeerLinkItem({
  id,
  index,
  mine,
  selfId,
  selfTitle,
  workspaceRoot,
  active,
  onOpen,
}: {
  id: string;
  index: PeerIndex;
  mine: { node: ReactNode; label: string };
  /** This thread's own run id and title, for the first row of the card. */
  selfId: string;
  selfTitle: string;
  workspaceRoot: string | null;
  active: boolean;
  onOpen?: (id: string) => void;
}) {
  const info = index.get(id);
  const theirs = markFor(info?.model, info?.provider);
  const name = peerName(id, index);
  const [expanded, setExpanded] = useState(false);
  const [exchange, setExchange] = useState<CoordinationEnvelopeSnapshot[] | "error" | null>(null);
  const toggleExchange = async () => {
    const next = !expanded;
    setExpanded(next);
    if (!next || !workspaceRoot) return;
    // Re-read on every unfold: delivery moves from waiting to read while the
    // card is up, and a reply may have landed. What is already shown stays
    // in place until the fresh list arrives.
    try {
      const snapshot = await readCoordinationSnapshot(workspaceRoot);
      setExchange(exchangeBetween(snapshot.envelopes, selfId, id));
    } catch {
      setExchange("error");
    }
  };
  const { open, pos, triggerRef, menuRef, openMenu, close } = usePortalMenu<{ left: number; bottom: number }>({
    computePos: (rect) => ({
      // Above the trigger, right edges aligned, clamped to the viewport.
      bottom: Math.round(window.innerHeight - rect.top + 8),
      left: Math.round(Math.min(Math.max(8, rect.right - CARD_WIDTH), window.innerWidth - CARD_WIDTH - 8)),
    }),
    closeOnOutsideClick: true,
  });
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
          <div style={{ fontSize: 10.5, lineHeight: 1.3, color: "var(--fg-dim)" }}>Agent conversation</div>
          {/* This thread first, then the peer. Only the peer is a link — the
              card is already inside this one. */}
          <div style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0, fontSize: 12, lineHeight: 1.35, color: "var(--fg-subtle)" }}>
            <span style={{ display: "grid", placeItems: "center", width: MARK, height: MARK, flexShrink: 0 }} title={mine.label}>{mine.node}</span>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{selfTitle}</span>
          </div>
          {/* The spine between the two conversations. Closed, it is a short
              bar with "Show exchange". Open, the bar runs alongside the
              messages and is itself the control that folds them back — no
              separate segment on top, no words. */}
          {!expanded ? (
            <button
              type="button"
              onClick={() => void toggleExchange()}
              aria-expanded={false}
              title="Show what was exchanged"
              style={{ display: "flex", alignItems: "stretch", gap: 9, padding: 0, border: 0, background: "transparent", color: "var(--fg-dim)", font: "inherit", fontSize: 10.5, lineHeight: 1.3, textAlign: "left", cursor: "pointer", minHeight: 16 }}
              onMouseEnter={(e) => { e.currentTarget.style.color = "var(--fg-subtle)"; }}
              onMouseLeave={(e) => { e.currentTarget.style.color = "var(--fg-dim)"; }}
            >
              <span aria-hidden style={{ width: MARK, display: "grid", justifyItems: "center", flexShrink: 0 }}>
                <span style={{ width: 1, height: "100%", minHeight: 16, background: "color-mix(in srgb, var(--border-strong) 70%, transparent)" }} />
              </span>
              <span style={{ alignSelf: "center" }}>Show exchange</span>
            </button>
          ) : (
            <div style={{ display: "flex", gap: 9, minWidth: 0 }}>
              <button
                type="button"
                onClick={() => void toggleExchange()}
                aria-expanded
                aria-label="Hide the exchange"
                title="Hide the exchange"
                style={{ width: MARK, display: "grid", justifyItems: "center", flexShrink: 0, padding: 0, border: 0, background: "transparent", cursor: "pointer" }}
              >
                <span aria-hidden style={{ width: 1, height: "100%", background: "color-mix(in srgb, var(--border-strong) 70%, transparent)" }} />
              </button>
              <div style={{ display: "grid", gap: 3, minWidth: 0, flex: 1, maxHeight: 180, overflowY: "auto", paddingRight: 2 }}>
                {exchange === "error" ? (
                  <div style={{ fontSize: 11, color: "var(--fg-dim)" }}>The exchange could not be read from the journal.</div>
                ) : !workspaceRoot ? (
                  <div style={{ fontSize: 11, color: "var(--fg-dim)" }}>Open the project to read the exchange.</div>
                ) : exchange === null ? (
                  <div style={{ fontSize: 11, color: "var(--fg-dim)" }}>Loading…</div>
                ) : exchange.length === 0 ? (
                  <div style={{ fontSize: 11, color: "var(--fg-dim)" }}>Nothing exchanged yet.</div>
                ) : (
                  exchange.map(({ envelope: e, deliveryState }) => {
                    const fromSelf = e.from.type === "run" && e.from.runId === selfId && e.toRunId === id && selfId !== id;
                    const sender = fromSelf || selfId === id ? mine : theirs;
                    // A reply sits one step under the message it answers, when
                    // that message is part of this exchange.
                    const reply = !!e.replyTo && exchange.some((s) => s.envelope.id === e.replyTo);
                    // Delivery earns a word only until it is read: queued is
                    // waiting on the receiving side's review; accepted waits for
                    // its next turn; delivered was shown but the turn did not
                    // finish; declined was refused. Read, the time takes the slot.
                    const pending = deliveryState === "acknowledged" ? null
                      : deliveryState === "queued" ? "to review"
                        : deliveryState === "accepted" ? "waiting"
                          : deliveryState === "delivered" ? "shown"
                            : "declined";
                    return <ExchangeRow key={e.id} envelope={e} sender={sender} fromSelf={fromSelf} reply={reply} pending={pending} />;
                  })
                )}
              </div>
            </div>
          )}
          <button
            type="button"
            disabled={!onOpen}
            onClick={() => { onOpen?.(id); close(); }}
            title={onOpen ? `Open ${info?.title ?? name}` : id}
            style={{ display: "flex", alignItems: "center", gap: 7, minWidth: 0, padding: 0, border: 0, background: "transparent", color: "var(--fg-strong)", font: "inherit", fontSize: 12, lineHeight: 1.35, textAlign: "left", cursor: onOpen ? "pointer" : "default" }}
            onMouseEnter={(e) => { if (onOpen) e.currentTarget.style.color = "var(--accent)"; }}
            onMouseLeave={(e) => { e.currentTarget.style.color = "var(--fg-strong)"; }}
          >
            <span style={{ display: "grid", placeItems: "center", width: MARK, height: MARK, flexShrink: 0 }} title={theirs.label}>{theirs.node}</span>
            <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{info?.title ?? name}</span>
          </button>
        </div>,
        document.body,
      )}
    </>
  );
}

export function PeerLink({
  peers,
  index,
  selfId,
  selfTitle,
  workspaceRoot,
  provider,
  model,
  active,
  onOpen,
}: {
  /** Run ids this thread has exchanged messages with. */
  peers: string[];
  index: PeerIndex;
  /** This thread's own run id and title, shown as the card's first row. */
  selfId: string;
  selfTitle: string;
  /** Where the coordination journal lives; the exchange is read from it. */
  workspaceRoot: string | null;
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
        <PeerLinkItem key={id} id={id} index={index} mine={mine} selfId={selfId} selfTitle={selfTitle} workspaceRoot={workspaceRoot} active={active} onOpen={onOpen} />
      ))}
    </div>
  );
}

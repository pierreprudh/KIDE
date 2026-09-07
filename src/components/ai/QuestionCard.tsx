import { useEffect, useRef } from "react";

import { AskIcon, SendIcon } from "../../icons";

/** Where the card is drawn. `island` is the Focus canvas' right column, under
 *  the plan island; `inline` is the strip above the composer everywhere else,
 *  since only the Focus canvas has a margin to spare. */
export type QuestionCardVariant = "inline" | "island";

type Props = {
  question: string;
  answer: string;
  onAnswerChange: (next: string) => void;
  onSubmit: () => void;
  onSkip: () => void;
  variant?: QuestionCardVariant;
};

/** Kit asked something and the run is parked until it hears back.
 *
 *  The card is a composer addressed to one question, so it is drawn as one:
 *  the question on top, a borderless answer box under it, a hairline foot with
 *  the same round send the composer uses. (What it replaced boxed the answer
 *  inside the box and filled Submit with accent — two frames and a colour the
 *  design system spends nowhere else.)
 *
 *  Both variants are this one component: a question is not worth two chat
 *  surfaces, the same way the plan is one TodoStrip in two placements. */
export function QuestionCard({
  question,
  answer,
  onAnswerChange,
  onSubmit,
  onSkip,
  variant = "inline",
}: Props) {
  const island = variant === "island";
  const answerRef = useRef<HTMLTextAreaElement>(null);
  const canSend = answer.trim().length > 0;

  // The answer box grows with its text the way the composer does, with the
  // same guards: an empty box falls back to its one-row min-height, and a box
  // that has not been laid out yet is left alone until it has been.
  useEffect(() => {
    const ta = answerRef.current;
    if (!ta) return;
    if (ta.value === "") {
      ta.style.height = "";
      return;
    }
    if (ta.clientWidth === 0) return;
    ta.style.height = "auto";
    ta.style.height = `${Math.min(ta.scrollHeight, island ? 120 : 168)}px`;
  }, [answer, island]);

  return (
    <section
      className={island ? "klide-ask-island" : "ai-qa-card"}
      aria-label="Question from the assistant"
      style={{
        // On the canvas it wears the island glass, so it and the plan read as
        // one family of windows; inline it stays on the panel's own surface
        // with the accent-tinted hairline every "waiting on you" card carries.
        ...(island
          ? {
            background: "var(--composer-glass)",
            border: "1px solid var(--composer-border)",
            borderRadius: 15,
            backdropFilter: "var(--composer-blur)",
            WebkitBackdropFilter: "var(--composer-blur)",
            pointerEvents: "auto" as const,
          }
          : {
            background: "color-mix(in srgb, var(--bg-elevated) 90%, transparent)",
            border: "1px solid color-mix(in srgb, var(--accent) 28%, var(--border))",
            borderRadius: "var(--radius-lg)",
            marginBottom: 8,
          }),
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {/* The mark says who is asking; the answer below indents to the same
          column, so question and answer read as one exchange rather than a
          label, a field and a toolbar. The island names itself the way the
          plan island does — inline, the conversation around it is the label. */}
      <div style={{ display: "flex", gap: 8, padding: island ? "12px 16px 0" : "10px 14px 0" }}>
        <span aria-hidden="true" style={{ flexShrink: 0, height: 18, display: "grid", placeItems: "center", color: "var(--accent)" }}>
          <AskIcon size={14} />
        </span>
        <div style={{ flex: 1, minWidth: 0, display: "grid", gap: island ? 6 : 0 }}>
          {island && (
            <span style={{ color: "var(--fg-subtle)", fontSize: 13, minHeight: 18, display: "flex", alignItems: "center" }}>Question</span>
          )}
          <div
            style={{
              minWidth: 0,
              color: "var(--fg-strong)",
              fontSize: island ? 12.5 : 13,
              lineHeight: 1.5,
              whiteSpace: "pre-wrap",
              // A long question is the island's own scroller, so it can never
              // push the answer box off the canvas.
              maxHeight: island ? 190 : undefined,
              overflowY: island ? "auto" : undefined,
              overscrollBehavior: "contain",
            }}
          >
            {question}
          </div>
        </div>
      </div>
      {/* In the island the question and the answer sit inches apart in a 320px
          card, and the placeholder read as one more line of the question. One
          hairline settles it — the same structure the plan island uses: header
          block, rule, body. Inline the card is wide enough not to need it. */}
      {island && (
        <span
          aria-hidden
          style={{ display: "block", height: 1, margin: "10px 0 0", background: "color-mix(in srgb, var(--border) 55%, transparent)" }}
        />
      )}
      <textarea
        ref={answerRef}
        className="klide-composer-textarea"
        autoFocus
        value={answer}
        onChange={(e) => onAnswerChange(e.target.value)}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            onSubmit();
          } else if (e.key === "Escape") {
            e.preventDefault();
            onSkip();
          }
        }}
        placeholder="Answer…"
        rows={1}
        style={{
          width: "100%",
          minHeight: 34,
          maxHeight: island ? 120 : 168,
          resize: "none",
          background: "transparent",
          border: "none",
          color: "var(--fg-strong)",
          font: "inherit",
          fontSize: island ? 13 : 13.5,
          lineHeight: 1.55,
          // Lines up under the question text, past the mark's column.
          padding: island ? "8px 16px 8px 38px" : "6px 14px 8px 36px",
          outline: "none",
          display: "block",
        }}
      />
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-end",
          gap: 4,
          padding: "6px 8px",
          borderTop: "1px solid color-mix(in srgb, var(--border) 30%, transparent)",
        }}
      >
        <button
          type="button"
          onClick={onSkip}
          title="Answer nothing and let the run carry on (Esc)"
          style={{
            height: 26,
            padding: "0 8px",
            border: "none",
            borderRadius: "var(--radius-sm)",
            background: "transparent",
            color: "var(--fg-subtle)",
            font: "inherit",
            fontSize: 11.5,
            cursor: "pointer",
            transition: "color var(--motion-fast) var(--ease-out), background var(--motion-fast) var(--ease-out)",
          }}
          onMouseEnter={(e) => { e.currentTarget.style.color = "var(--fg-strong)"; e.currentTarget.style.background = "var(--bg-hover)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.color = "var(--fg-subtle)"; e.currentTarget.style.background = "transparent"; }}
        >
          Skip
        </button>
        <button
          type="button"
          onClick={onSubmit}
          disabled={!canSend}
          aria-label="Send answer"
          title="Send answer (⌘↩)"
          style={{
            width: 30,
            height: 30,
            flexShrink: 0,
            display: "grid",
            placeItems: "center",
            borderRadius: "50%",
            color: canSend ? "var(--control-primary-fg)" : "var(--fg-dim)",
            background: canSend ? "var(--accent)" : "var(--bg-elevated)",
            border: canSend ? "none" : "1px solid var(--border)",
            cursor: canSend ? "pointer" : "default",
            transition: "background var(--motion-med) var(--ease-out), color var(--motion-med) var(--ease-out), filter var(--motion-fast) var(--ease-out)",
          }}
          onMouseEnter={(e) => { if (canSend) e.currentTarget.style.filter = "brightness(1.08)"; }}
          onMouseLeave={(e) => { e.currentTarget.style.filter = "none"; }}
        >
          <SendIcon size={14} />
        </button>
      </div>
    </section>
  );
}

import { useEffect, useId, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { hasCompletionReview, type RunCompletion } from "../../agent/completion";
import { ChevronIcon, CloseIcon, ReviewIcon } from "../../icons";
import { Z } from "../../zLayers";
import "./completionCard.css";

/** Where the entry sits. `inline` is the row under the turn that produced it;
 *  `island` is the Focus canvas' right column, under the plan — the run's
 *  result waiting where its plan just was, rather than at the far end of a
 *  transcript the reader has to scroll back down to. */
export type CompletionCardVariant = "inline" | "island";

type Props = {
  completion: RunCompletion;
  disabled?: boolean;
  onReview?: (path?: string) => void;
  onRequestChanges: () => void;
  variant?: CompletionCardVariant;
  /** Too little room for the words: the entry keeps the mark and the count,
   *  and the label it drops moves to its tooltip and accessible name. */
  compact?: boolean;
  /** Put the entry away — the canvas column's windows are all dismissible, so
   *  a result the reader is done with leaves the corner like a plan does. */
  onDismiss?: () => void;
};

type EvidenceProps = Pick<Props, "completion" | "disabled" | "onReview" | "onRequestChanges"> & {
  onDone: () => void;
};

/** The evidence itself — the same sections and the same two actions wherever
 *  it is read: inside the island card on the canvas, or in the sheet the
 *  transcript's entry opens. Exported so its markup can be tested without a
 *  DOM to click in. */
export function ResultEvidence({ completion, disabled, onReview, onRequestChanges, onDone }: EvidenceProps) {
  const review = (path?: string) => { onDone(); onReview?.(path); };
  return (
    <>
      <div className="klide-result-body">
        {completion.files.length > 0 && <section aria-label="Changed files">
          <h3>Changes</h3>
          <div className="klide-result-files">{completion.files.map((path) => {
            const name = path.split("/").pop() || path;
            const directory = path.slice(0, -name.length).replace(/\/$/, "");
            const label = <><span className="klide-result-filename">{name}</span>{directory && <span className="klide-result-directory">{directory}</span>}</>;
            return onReview ? <button key={path} type="button" title={`Review ${path}`} onClick={() => review(path)}>{label}<span aria-hidden="true">↗</span></button> : <div key={path}>{label}</div>;
          })}</div>
        </section>}
        {completion.commands.length > 0 && <section aria-label="Command results">
          <h3>Commands <span>{completion.commands.length}</span></h3>
          {completion.commands.map((command) => <details key={command.id} className="klide-result-command">
            <summary><code>{command.label}</code><span className={`klide-result-status-${command.status}`}>{command.status === "unknown" ? "No result" : command.status === "passed" ? "Passed" : "Failed"}</span></summary>
            <pre>{command.output || "No output recorded."}</pre>
          </details>)}
        </section>}
        {completion.warnings.length > 0 && <section className="klide-result-notes" aria-label="Review notes"><h3>Worth a look</h3>{completion.warnings.map((warning) => <p key={warning}>{warning}</p>)}</section>}
      </div>
      <footer className="klide-result-footer">
        {completion.files.length > 0 && onReview && <button type="button" className="klide-result-primary" onClick={() => review()}>Review changes <span aria-hidden="true">↗</span></button>}
        <button type="button" disabled={disabled} onClick={() => { onDone(); onRequestChanges(); }}>Request changes</button>
      </footer>
    </>
  );
}

/** A quiet entry point. On the canvas the evidence opens inside the card, in
 *  the column the plan already lives in; in a transcript it opens as a sheet. */
export function CompletionCard({ completion, disabled, onReview, onRequestChanges, variant = "inline", compact = false, onDismiss }: Props) {
  const island = variant === "island";
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const id = useId();

  // The sheet is modal, so Escape closes it and focus goes back to the row
  // that opened it. The island is part of the page — Escape belongs to the
  // conversation there, not to a card sitting in the corner.
  useEffect(() => {
    if (island || !open) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [island, open]);

  if (!hasCompletionReview(completion)) return null;

  const failed = completion.commands.filter((command) => command.status !== "passed").length;
  const attention = failed + completion.warnings.length;
  const label = completion.stopped ? "Review partial work" : "Review result";
  const title = completion.stopped ? "Partial work" : "Result";
  const files = completion.files.length > 0
    ? `${completion.files.length} file${completion.files.length === 1 ? "" : "s"}`
    : "";
  const dot = attention > 0 && <span className="klide-result-attention-dot" aria-label={`${attention} item${attention === 1 ? "" : "s"} to review`} />;
  // What the compact mark cannot say, its name says.
  const spoken = [label, files, attention > 0 ? `${attention} item${attention === 1 ? "" : "s"} to review` : ""]
    .filter(Boolean).join(" · ");

  if (island) {
    // One window in the canvas column, built like the plan above it: a header
    // that is the whole hit target, a hairline that appears with the body, and
    // the body growing into the column rather than over the app.
    return (
      <section className="klide-result-island" data-open={open ? "1" : undefined} aria-label={title}>
        <div className="klide-result-island-header" role="button" tabIndex={0}
          aria-expanded={open} aria-controls={id}
          aria-label={`${open ? "Collapse" : "Expand"} ${title.toLowerCase()}${files ? `, ${files}` : ""}${compact && attention > 0 ? `, ${attention} item${attention === 1 ? "" : "s"} to review` : ""}`}
          title={compact ? spoken : undefined}
          data-compact={compact ? "1" : undefined}
          data-attention={attention > 0 ? "1" : undefined}
          onClick={() => setOpen((was) => !was)}
          onKeyDown={(event) => {
            if (event.key !== "Enter" && event.key !== " ") return;
            event.preventDefault();
            setOpen((was) => !was);
          }}>
          {/* A 232px column is a corner, not a panel: the header keeps one
              mark and drops the rest — the title, the count, the attention
              dot and the chevron. What they said is in the header's own
              name and tooltip, and "needs attention" becomes the mark's
              colour rather than a dot pinned beside it. */}
          <ReviewIcon size={15} />
          {!compact && <>
            <span className="klide-result-island-title">{title}</span>
            {files && <span className="klide-result-meta">{files}</span>}
            {dot}
            <span className="klide-result-island-chevron" aria-hidden="true"><ChevronIcon open={open} /></span>
          </>}
          {onDismiss && (
            <button type="button" className="klide-result-island-close" aria-label="Hide this result"
              onClick={(event) => { event.stopPropagation(); onDismiss(); }}>
              <CloseIcon size={14} />
            </button>
          )}
        </div>
        <div className="klide-result-island-rule" data-shown={open ? "1" : undefined} aria-hidden="true" />
        {/* Open, the card takes the rest of the column: the evidence scrolls
            inside it and the two actions stay on the floor of the card, so
            nothing ends mid-word against a hard edge. */}
        {open && (
          <div className="klide-result-island-panel" id={id}>
            <ResultEvidence completion={completion} disabled={disabled} onReview={onReview}
              onRequestChanges={onRequestChanges} onDone={() => setOpen(false)} />
          </div>
      )}
      </section>
    );
  }

  const close = () => { setOpen(false); trigger.current?.focus(); };
  return (
    <div className="klide-result-entry" data-variant={variant}>
      <button ref={trigger} type="button" className="klide-result-trigger" data-compact={compact ? "1" : undefined}
        aria-haspopup="dialog" aria-expanded={open} aria-controls={open ? id : undefined}
        data-attention={attention > 0 ? "1" : undefined}
        aria-label={compact ? spoken : undefined}
        title={compact ? spoken : undefined}
        onClick={() => setOpen(true)}>
        {/* Compact is one mark and nothing else: no count beside it, no dot on
            top of it. What the words carried moves to the tooltip and the
            accessible name, and "needs attention" becomes the mark's own
            colour rather than a second thing to look at. */}
        {compact ? <ReviewIcon size={16} /> : <>
          <span>{label}</span>
          {files && <span className="klide-result-meta">{files}</span>}
          {dot}
          <span aria-hidden="true" className="klide-result-arrow">↗</span>
        </>}
      </button>
      {/* Portalled to the body, on the app's own Z scale: an AI panel sits
          inside transformed and clipped ancestors that a sheet left in the
          tree inherits — including the canvas column's click pass-through,
          which used to leave the sheet unclickable over a backdrop that
          blocked everything else. */}
      {open && typeof document !== "undefined" && createPortal(
        <div className="klide-result-scrim" style={{ zIndex: Z.modal }} onClick={close}>
          <div className="klide-result-drawer" id={id} role="dialog" aria-modal="true" aria-labelledby={`${id}-title`}
            onClick={(event) => event.stopPropagation()}>
            <header className="klide-result-header">
              <div><h2 id={`${id}-title`}>{title}</h2><p>{completion.files.length ? `${completion.files.length} changed file${completion.files.length === 1 ? "" : "s"}` : "Items to review"}</p></div>
              <button type="button" autoFocus className="klide-result-close" aria-label="Close result" onClick={close}><CloseIcon size={18} /></button>
            </header>
            <ResultEvidence completion={completion} disabled={disabled} onReview={onReview}
              onRequestChanges={onRequestChanges} onDone={close} />
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}

import { useId, useRef, useState } from "react";
import { hasCompletionReview, type RunCompletion } from "../../agent/completion";
import { CloseIcon, ReviewIcon } from "../../icons";
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
};

/** A quiet entry point. Evidence opens on demand in the right-hand drawer. */
export function CompletionCard({ completion, disabled, onReview, onRequestChanges, variant = "inline", compact = false }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const id = useId();
  if (!hasCompletionReview(completion)) return null;

  const failed = completion.commands.filter((command) => command.status !== "passed").length;
  const attention = failed + completion.warnings.length;
  const close = () => dialog.current?.close();
  const review = (path?: string) => { close(); onReview?.(path); };
  const label = completion.stopped ? "Review partial work" : "Review result";
  const files = completion.files.length > 0
    ? `${completion.files.length} file${completion.files.length === 1 ? "" : "s"}`
    : "";
  return (
    <div className="klide-result-entry" data-variant={variant}>
      <button type="button" className="klide-result-trigger" data-compact={compact ? "1" : undefined}
        aria-haspopup="dialog" aria-expanded={open} aria-controls={id}
        aria-label={compact ? [label, files].filter(Boolean).join(", ") : undefined}
        title={compact ? [label, files].filter(Boolean).join(" · ") : undefined}
        onClick={() => { dialog.current?.showModal(); setOpen(true); }}>
        {compact
          ? <ReviewIcon size={15} />
          : <span>{label}</span>}
        {files && <span className="klide-result-meta">{compact ? completion.files.length : files}</span>}
        {attention > 0 && <span className="klide-result-attention-dot" aria-label={`${attention} item${attention === 1 ? "" : "s"} to review`} />}
        {!compact && <span aria-hidden="true" className="klide-result-arrow">↗</span>}
      </button>
      <dialog ref={dialog} id={id} className="klide-result-drawer" aria-labelledby={`${id}-title`}
        onClose={() => setOpen(false)}
        onClick={(event) => {
          if (event.target !== event.currentTarget) return;
          const rect = event.currentTarget.getBoundingClientRect();
          if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
        }}>
        <header className="klide-result-header">
          <div><h2 id={`${id}-title`}>{completion.stopped ? "Partial work" : "Result"}</h2><p>{completion.files.length ? `${completion.files.length} changed file${completion.files.length === 1 ? "" : "s"}` : "Items to review"}</p></div>
          <button type="button" autoFocus className="klide-result-close" aria-label="Close result" onClick={close}><CloseIcon size={18} /></button>
        </header>
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
          <button type="button" disabled={disabled} onClick={() => { close(); onRequestChanges(); }}>Request changes</button>
        </footer>
      </dialog>
    </div>
  );
}

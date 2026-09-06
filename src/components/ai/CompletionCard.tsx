import { useId, useRef, useState } from "react";
import { hasCompletionReview, type RunCompletion } from "../../agent/completion";
import { CloseIcon } from "../../icons";
import "./completionCard.css";

type Props = {
  completion: RunCompletion;
  disabled?: boolean;
  onReview?: (path?: string) => void;
  onRequestChanges: () => void;
};

/** A quiet entry point. Evidence opens on demand in the right-hand drawer. */
export function CompletionCard({ completion, disabled, onReview, onRequestChanges }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [open, setOpen] = useState(false);
  const id = useId();
  if (!hasCompletionReview(completion)) return null;

  const failed = completion.commands.filter((command) => command.status !== "passed").length;
  const attention = failed + completion.warnings.length;
  const close = () => dialog.current?.close();
  const review = (path?: string) => { close(); onReview?.(path); };
  return (
    <div className="klide-result-entry">
      <button type="button" className="klide-result-trigger" aria-haspopup="dialog" aria-expanded={open} aria-controls={id}
        onClick={() => { dialog.current?.showModal(); setOpen(true); }}>
        <span>Review result</span>
        {completion.files.length > 0 && <span className="klide-result-meta">{completion.files.length} file{completion.files.length === 1 ? "" : "s"}</span>}
        {attention > 0 && <span className="klide-result-attention-dot" aria-label={`${attention} item${attention === 1 ? "" : "s"} to review`} />}
        <span aria-hidden="true" className="klide-result-arrow">↗</span>
      </button>
      <dialog ref={dialog} id={id} className="klide-result-drawer" aria-labelledby={`${id}-title`}
        onClose={() => setOpen(false)}
        onClick={(event) => {
          if (event.target !== event.currentTarget) return;
          const rect = event.currentTarget.getBoundingClientRect();
          if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
        }}>
        <header className="klide-result-header">
          <div><h2 id={`${id}-title`}>Result</h2><p>{completion.files.length ? `${completion.files.length} changed file${completion.files.length === 1 ? "" : "s"}` : "Items to review"}</p></div>
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

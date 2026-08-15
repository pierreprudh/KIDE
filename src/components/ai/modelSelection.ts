// Which model a live Conversation is on — and, more importantly, what is
// allowed to change it.
//
// The Conversation's `model` is metadata about a Run that already happened:
// the rail draws the maker's mark from it, Mission Control files the row under
// it, and cost is priced from it. So it must only ever move when a human picks
// a model, or when the Provider itself says the current pick does not exist.
// Two host-side echoes used to move it anyway:
//
//   * the `model` prop. It is App's idea of this panel's model, restored from
//     the persisted layout — it can be older than the session (a layout saved
//     before the Provider's model list corrected the pick). Adopting it
//     whenever it *differs* turns every unrelated App re-render into an edit.
//   * a failed model-list fetch. Falling back to this Provider's remembered
//     model treats a network error as a pick, and the remembered value can
//     belong to another Provider entirely.
//
// Both fired on one thread: it ran on `qwen3.8:27b-mlx` (the Rust run summary
// still says so) and was saved as `pierreprudh/lfm2.5-8b-a1b:latest`, so the
// history rail showed a LiquidAI mark for a Qwen conversation.

/** The host's model prop, as last observed by the panel. `undefined` before
 *  the panel has observed one (i.e. on mount). */
export type HostModelSync = {
  hostModel: string;
  /** The previous value of the same prop, or undefined on mount. */
  lastHostModel: string | undefined;
  sessionModel: string;
};

/**
 * The model this panel should adopt from its host, or `null` to keep the
 * session's own. A host prop is a pick only when it *changed*; a prop that has
 * held the same (possibly stale) value since the last render is an echo, and
 * an echo must never overwrite the Conversation the panel is showing.
 */
export function hostModelAdoption({
  hostModel,
  lastHostModel,
  sessionModel,
}: HostModelSync): string | null {
  if (lastHostModel === undefined) return null; // mount: the session owns the pair
  if (hostModel === lastHostModel) return null; // unchanged prop — an echo, not a pick
  if (!hostModel || hostModel === sessionModel) return null;
  return hostModel;
}

/**
 * Which model the picker offers when the Provider's model list can't be read.
 * The session's own model wins: the list failed, so nothing has been learned
 * about whether that model exists. The remembered value only fills a genuinely
 * empty session (a panel that has never resolved a model at all).
 */
export function offlineModelFallback(
  sessionModel: string,
  rememberedModel: string,
): string {
  return sessionModel || rememberedModel;
}

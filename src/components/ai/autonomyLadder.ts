// The four rungs of agent autonomy, in one place.
//
// **Mode** is a domain noun (see CONTEXT.md): the capability tier of a Run —
// `chat` (no tools), `plan` (read-only tools), `goal` (full tools). What the UI
// offers is Mode crossed with the diff-review policy, which makes four rungs.
//
// That ladder was written out twice — `MODE_RUNGS` in AiPanel and
// `FOCUS_MODE_CHOICES` in FocusMode — same four `(mode, review)` pairs, same
// four labels, different descriptions. Two hand-kept tables for one domain
// concept, and a fifth rung would have to be added to both.

import type { AgentMode } from "../../agent/types";

export type AutonomyRung = {
  /** Stable key for React lists and persistence. */
  key: string;
  mode: AgentMode;
  /** The diff-review policy this rung implies. `null` means "not applicable" —
   *  chat and plan never propose an edit to review. */
  review: boolean | null;
  /** Whether shell commands also run without a permission prompt. `null` means
   *  "not applicable" — chat and plan have no command tool. Only the top rung
   *  sets this true, and it is never persisted: on reload every panel falls
   *  back to prompting. */
  commands: boolean | null;
  label: string;
  /** One short clause. Lower-case, no trailing period: it renders as a
   *  subtitle under the label. */
  description: string;
};

export const AUTONOMY_RUNGS: AutonomyRung[] = [
  { key: "chat", mode: "chat", review: null, commands: null, label: "Chat", description: "no tools" },
  { key: "plan", mode: "plan", review: null, commands: null, label: "Plan", description: "read-only, proposes" },
  {
    key: "goal-review",
    mode: "goal",
    review: true,
    commands: false,
    label: "Goal · review",
    description: "approve each edit",
  },
  {
    key: "goal-auto",
    mode: "goal",
    review: false,
    commands: false,
    label: "Goal · auto-accept",
    description: "edits apply, commands still ask",
  },
  {
    key: "goal-full",
    mode: "goal",
    review: false,
    commands: true,
    label: "Goal · full auto",
    description: "edits and commands, no prompts",
  },
];

/** Which rung is currently selected. `review` and `commands` are only
 *  consulted for `goal` — the only Mode that can edit or run a command. */
export function currentRungIndex(
  mode: AgentMode,
  requireDiffReview: boolean,
  autoApproveCommands = false
): number {
  const idx = AUTONOMY_RUNGS.findIndex(
    (r) =>
      r.mode === mode &&
      (r.review === null || r.review === requireDiffReview) &&
      (r.commands === null || r.commands === autoApproveCommands)
  );
  return idx >= 0 ? idx : 0;
}

/**
 * The rung a Mode collapses to when the model cannot call tools.
 *
 * A model with no tool support cannot execute a Goal, so offering one would
 * produce a run that silently does nothing. Delegate providers are exempt: the
 * CLI behind them runs its own tools, so Klide's view of "does this model
 * support tools" does not apply.
 *
 * Both surfaces had their own copy of this and they had already diverged —
 * FocusMode's omitted the delegate exemption. It didn't bite only because Focus
 * filters delegates out of its picker, which is a coincidence, not a reason.
 */
export function effectiveMode(opts: {
  mode: AgentMode;
  modelSupportsTools: boolean;
  providerDelegatesWork: boolean;
}): AgentMode {
  const { mode, modelSupportsTools, providerDelegatesWork } = opts;
  if (mode === "goal" && !modelSupportsTools && !providerDelegatesWork) return "chat";
  return mode;
}

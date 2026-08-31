// The agent's autonomy, in one place — split along the seam the UI wears it:
//
// **Mode** is a domain noun (see CONTEXT.md): the capability tier of a Run —
// `chat` (no tools), `plan` (read-only tools), `goal` (full tools). The + menu
// offers exactly these three.
//
// **Goal policy** is what Goal mode does with its two gates: review every edit
// (the default), auto-accept edits (commands still ask), or full auto (edits
// and commands, no prompts). The conversation foot bar is the decider — its
// standing note names the policy and a click cycles to the next — so the menu
// never grows a rung per policy again.

import type { AgentMode } from "../../agent/types";

export type ModeChoice = {
  mode: AgentMode;
  label: string;
  /** One short clause. Lower-case, no trailing period: it renders as a
   *  subtitle under the label. */
  description: string;
};

export const MODE_CHOICES: ModeChoice[] = [
  { mode: "chat", label: "Chat", description: "no tools" },
  { mode: "plan", label: "Plan", description: "read-only, proposes" },
  { mode: "goal", label: "Goal", description: "edits and commands" },
];

export type GoalPolicy = "review" | "auto" | "full";

export type GoalPolicyChoice = {
  key: GoalPolicy;
  /** The foot-bar note's text. Lower-case: it sits beside the branch label. */
  label: string;
  /** What the run request gets. `commands: true` is never persisted — on
   *  reload every panel falls back to prompting. */
  review: boolean;
  commands: boolean;
};

/** Cycle order — each click on the foot-bar note escalates one step, then
 *  wraps back to the reviewing default. */
export const GOAL_POLICIES: GoalPolicyChoice[] = [
  { key: "review", label: "reviewing edits", review: true, commands: false },
  { key: "auto", label: "auto-accept edits", review: false, commands: false },
  { key: "full", label: "full auto", review: false, commands: true },
];

/** Which policy the current pair of gate flags spells. An off-ladder combo
 *  (review on + commands on) reads as review — the safest gate wins. */
export function goalPolicyOf(requireDiffReview: boolean, autoApproveCommands: boolean): GoalPolicyChoice {
  const match = GOAL_POLICIES.find(
    (p) => p.review === requireDiffReview && p.commands === (requireDiffReview ? false : autoApproveCommands)
  );
  return match ?? GOAL_POLICIES[0];
}

/** The next rung on the click cycle. */
export function nextGoalPolicy(current: GoalPolicy): GoalPolicyChoice {
  const idx = GOAL_POLICIES.findIndex((p) => p.key === current);
  return GOAL_POLICIES[(idx + 1) % GOAL_POLICIES.length];
}

/**
 * The mode a pick collapses to when the model cannot call tools.
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

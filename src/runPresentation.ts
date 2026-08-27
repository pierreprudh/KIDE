// How a Run's state becomes a word and a colour. One home, for every surface.
//
// `runs.ts` has carried a comment headed "The one status vocabulary" for a
// while, and the vocabulary it describes is right:
//
//   Working / Waiting / Blocked / Done  — the four core states
//   Queued / Stopped / Failed / Idle    — genuinely distinct, not synonyms
//   Waiting  = output is sitting on you (turn done, review ready)
//   Blocked  = the agent cannot proceed without you
//
// What was missing is a single place that applies it. The words and tones were
// spread over eight tables — `STATUS_COLOR`, `LIFECYCLE_COLOR`,
// `ATTENTION_TONE`, MissionControl's `LIVE_STATUS_TEXT`/`LIVE_STATUS_COLOR` and
// `reasonToneColor`, an inline validation ternary, OrchestratorConsole's
// `StatusBadge` chain, and MissionGraph's `statusColor` — so adding a state
// meant finding all eight, and the vocabulary comment could not be checked
// against anything.
//
// ── The `waiting` overlap, deliberately preserved ──────────────────────────
// Two different types spell a state `"waiting"`, and they mean opposite things:
//
//   RunStatus.waiting          → **Blocked**  (amber)
//     A run parked on a permission prompt, a diff gate, or an explicit pause.
//     Harness wire values fold into this state; a hosted Delegate reaches it
//     only from a real `blocked` hook. The agent cannot proceed. Blocked is
//     correct.
//
//   LiveDelegateStatus.waiting → **Waiting**  (green)
//     A Delegate CLI whose turn has finished and is idle at its composer —
//     `delegate/status.rs` documents it as exactly that. The output is sitting
//     on you. Waiting is correct.
//
// Both are right for their own vocabulary. Rust translates a live Delegate's
// `blocked` hook to board `waiting`, while live `waiting` settles its historical
// transcript row as `done`; the green Live strip remains the place that says
// its finished output is waiting on you. They are separated here by taking the
// vocabulary as a parameter, so the distinction is visible in one file instead
// of implied across two.

import type { RunStatus, RunLifecycleStatus, RunBoardSection, RunBoardReasonTone } from "./runs";
import type { LiveDelegateSession } from "./ipc/delegatePty";
import type { MissionTaskStatus } from "./agent/missionHarness";
import type { ValidationStatus } from "./agent/validationContracts";

/** The eight words. Nothing outside this module invents a ninth. */
export type StateWord =
  | "Working"
  | "Waiting"
  | "Blocked"
  | "Done"
  | "Queued"
  | "Stopped"
  | "Failed"
  | "Idle";

/** Semantic tone, resolved to a CSS custom property by `toneColor`. Kept
 *  separate from the colour so a surface can restyle without re-deciding what
 *  a state means. */
export type StateTone = "active" | "attention" | "ready" | "settled" | "quiet" | "bad";

export type StatePresentation = { word: StateWord; tone: StateTone };

const TONE_COLOR: Record<StateTone, string> = {
  active: "var(--accent)",
  // Amber: the agent is stuck on you. Matches the AI panel's context meter.
  attention: "var(--warning)",
  ready: "var(--success)",
  settled: "var(--success)",
  quiet: "var(--fg-subtle)",
  bad: "var(--danger)",
};

export function toneColor(tone: StateTone): string {
  return TONE_COLOR[tone];
}

/** A board row's status. See the `waiting` note above: here it is **Blocked**. */
export function presentRunStatus(status: RunStatus): StatePresentation {
  switch (status) {
    case "running":
      return { word: "Working", tone: "active" };
    case "waiting":
      return { word: "Blocked", tone: "attention" };
    case "queued":
      return { word: "Queued", tone: "quiet" };
    case "done":
      return { word: "Done", tone: "settled" };
    case "cancelled":
      return { word: "Stopped", tone: "quiet" };
    case "error":
      return { word: "Failed", tone: "bad" };
  }
}

/** The richer lifecycle, which separates "blocked on you" from "ready to read". */
export function presentLifecycle(status: RunLifecycleStatus): StatePresentation {
  switch (status) {
    case "queued":
      return { word: "Queued", tone: "quiet" };
    case "running":
      return { word: "Working", tone: "active" };
    case "waiting":
      return { word: "Blocked", tone: "attention" };
    case "needs_review":
      return { word: "Waiting", tone: "ready" };
    case "done":
      return { word: "Done", tone: "settled" };
    case "failed":
      return { word: "Failed", tone: "bad" };
    case "cancelled":
      return { word: "Stopped", tone: "quiet" };
  }
}

/** Section headings. Same four words as the row states they contain. */
export function presentBoardSection(section: RunBoardSection): StateWord {
  switch (section) {
    case "running":
      return "Working";
    case "blocked":
      return "Blocked";
    case "ready_for_review":
      return "Waiting";
    case "done":
      return "Done";
  }
}

/** A live Delegate session. See the `waiting` note above: here it is
 *  **Waiting**, because the turn has finished and the output is on you. */
export function presentLiveDelegate(
  status: LiveDelegateSession["status"]
): StatePresentation {
  switch (status) {
    // The activity timer says "running"; the hook layer says "working". Same
    // state, two producers.
    case "running":
    case "working":
      return { word: "Working", tone: "active" };
    case "idle":
      return { word: "Idle", tone: "quiet" };
    case "blocked":
      return { word: "Blocked", tone: "attention" };
    case "waiting":
      return { word: "Waiting", tone: "ready" };
  }
}

/** Board-reason tones, which are editorial rather than lifecycle states. Only
 *  danger earns a colour of its own; the rest stay quiet so the row's own
 *  status word carries the state. */
export function presentReasonTone(tone: RunBoardReasonTone): string {
  return tone === "danger" ? toneColor("bad") : toneColor("quiet");
}

/** Validation status, as recorded by the Rust Harness and parsed at the IPC
 *  edge (`parseValidationSummary` in `agent/validationContracts.ts` — the
 *  union, not a bare string, so a new wire word is a tsc error here).
 *  `"unknown"` is a durable log carrying a word this build doesn't know: it
 *  stays quiet rather than asserting a verdict. */
export function presentValidation(status: ValidationStatus | null | undefined): StateTone {
  if (status == null) return "quiet";
  switch (status) {
    case "passed":
      return "settled";
    case "failed":
      return "bad";
    case "unverified":
      return "attention";
    case "skipped":
    case "unknown":
      return "quiet";
  }
}

/** The Orchestrator board's card states — the MissionTaskStatus vocabulary,
 *  as arbitrated by `agent/missionBoard.ts`. Its words stay lowercase mono — a
 *  deliberately quieter register than the run board's — but the tones come from
 *  here so a colour decision is made once. */
export function presentMissionCardTone(status: MissionTaskStatus): StateTone {
  switch (status) {
    case "running":
    case "validating":
      return "active";
    case "review":
    case "interrupted":
      return "attention";
    case "failed":
      return "bad";
    default:
      // queued / ready / blocked / assigned / waiting / done / cancelled all
      // recede — the board's live work carries the colour.
      return "quiet";
  }
}

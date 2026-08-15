// What leaving a conversation does to the Run working in it.
//
// It used to do exactly one thing: abort. Opening another thread from the rail,
// or starting a fresh chat, stopped the agent mid-work — the panel had no way
// to show a run it was no longer looking at, so killing it was the only way to
// keep the view honest. The rail can show it now (`runningConversations.ts`
// animates the row of every live run), so leaving is navigation again and the
// run is left alone: the panel stops listening, and picks the stream back up
// if you return.
//
// One case still ends the run. A run parked on a decision — a diff to approve,
// a permission to grant, a question to answer — is waiting on a card that only
// the panel showing it draws. Nothing replays that card: `foldEvents` doesn't
// carry the request, and Rust holds the reply channel in a oneshot with no
// accessor. Walk away from one and the run waits forever, holding its turn
// budget and its worktree with no surface left to answer from. So those are
// aborted, which is what an abandoned decision amounts to anyway. Restoring
// the card on return needs the pending request exposed from `agent/mod.rs`
// first; until then, "we asked you something" is the one thing that pins a run
// to the panel that started it.

export type RunLeaveState = {
  /** This panel owns a live Harness Run for the conversation being left. */
  hasActiveRun: boolean;
  /** That run is parked on a diff / permission / question card. */
  parkedOnDecision: boolean;
};

export type RunLeaveDecision = {
  /** Stop the run in Rust. Otherwise it keeps working while you're away. */
  abort: boolean;
  /** Mark the conversation done on the run board. False while the run lives —
   *  settling it there would hide a working agent from the board and stop its
   *  rail row animating. */
  settle: boolean;
};

export function decideOnLeavingRun(state: RunLeaveState): RunLeaveDecision {
  if (!state.hasActiveRun) return { abort: false, settle: true };
  if (state.parkedOnDecision) return { abort: true, settle: true };
  return { abort: false, settle: false };
}

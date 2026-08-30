// What leaving a conversation does to the Run working in it.
//
// It used to do exactly one thing: abort. Opening another thread from the rail,
// or starting a fresh chat, stopped the agent mid-work — the panel had no way
// to show a run it was no longer looking at, so killing it was the only way to
// keep the view honest. The rail can show it now (`runningConversations.ts`
// animates the row of every live run), so leaving is navigation again: the
// panel stops listening, and picks the stream back up if you return.
//
// A run parked on a decision — a diff to approve, a permission to grant, a
// question to answer — was the one case that still aborted, because nothing
// could put its card back on screen: `foldEvents` doesn't carry the request,
// and Rust holds the reply channel in a oneshot with no accessor. A parked run
// nobody could answer was a run that would wait forever, so ending it was the
// lesser harm.
//
// `agent/pendingGates.ts` removed that argument. The requests are persisted
// like every other event, so the transcript says what a run is waiting on, and
// the panel restores the card when it reattaches. Nothing has to die for the
// view to stay honest, so nothing does.

export type RunLeaveState = {
  /** This panel owns a live Harness Run for the conversation being left. */
  hasActiveRun: boolean;
};

export type RunLeaveDecision = {
  /** Stop the run in Rust. Nothing sets this now; leaving is navigation. */
  abort: boolean;
  /** Mark the conversation done on the run board. False while the run lives —
   *  settling it there would hide a working agent from the board and stop its
   *  rail row animating. */
  settle: boolean;
};

export function decideOnLeavingRun(state: RunLeaveState): RunLeaveDecision {
  return { abort: false, settle: !state.hasActiveRun };
}

export type ConversationArrival = {
  /** The conversation being opened is the one already on screen. */
  sameConversation: boolean;
  /** This panel is still wired to a live run stream for what it shows —
   *  the original `startAgentRun` channel or a reattach follower. */
  followingLiveRun: boolean;
};

/**
 * Whether opening a conversation should re-adopt it — detach, replace the
 * view with the stored snapshot, re-follow the run.
 *
 * The one refusal: re-selecting the thread already on screen while this
 * panel is still following its run. The original channel is the only stream
 * that carries token deltas — the global reattach broadcast replays persisted
 * structural events only — so re-adopting here trades a streaming view for a
 * chunky one, for a click that asked to see exactly what is already showing.
 */
export function shouldReadoptConversation(arrival: ConversationArrival): boolean {
  return !(arrival.sameConversation && arrival.followingLiveRun);
}

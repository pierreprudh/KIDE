// The Git Review model — the pure policy behind `components/GitReview.tsx`,
// in the same spirit as `gitGraph.ts`: derivations over the wire types plus
// the outcome of every mutating action (its notice text, which surface data
// it must re-fetch, and which selections it clears). The component stays a
// view: it calls the ipc wrapper, then applies the returned outcome.

import type { GitFile } from "./gitTypes";
import type { PrComment, PrCommit, PullRequest, PullRequestDetails } from "./ipc/git";

// ── Derivations ──────────────────────────────────────────────────────────────

export type PullRequestFilter = "open" | "draft" | "merged" | "all";

export function visiblePrs(prs: PullRequest[], filter: PullRequestFilter): PullRequest[] {
  return prs.filter((pr) => {
    if (filter === "open") return pr.badge === "open";
    if (filter === "draft") return pr.badge === "draft";
    if (filter === "merged") return pr.badge === "merged";
    return true;
  });
}

export type PrCounts = { open: number; draft: number; merged: number; all: number };

export function prCounts(prs: PullRequest[]): PrCounts {
  return {
    open: prs.filter((pr) => pr.badge === "open").length,
    draft: prs.filter((pr) => pr.badge === "draft").length,
    merged: prs.filter((pr) => pr.badge === "merged").length,
    all: prs.length,
  };
}

export function splitStatusFiles(files: GitFile[]): { stagedFiles: GitFile[]; changedFiles: GitFile[] } {
  return {
    stagedFiles: files.filter((f) => f.staged),
    changedFiles: files.filter((f) => !f.staged),
  };
}

/** The status-bar change count — every working-tree entry, staged or not. */
export function totalAdditions(files: GitFile[]): number {
  const { stagedFiles, changedFiles } = splitStatusFiles(files);
  return changedFiles.length + stagedFiles.length;
}

/** One entry of the PR conversation timeline: commits and comments
 *  interleaved in time, after the opening description. */
export type PrTimelineEvent =
  | { kind: "commit"; at: number; commit: PrCommit }
  | { kind: "comment"; at: number; comment: PrComment };

export function mergePrTimeline(
  detail: Pick<PullRequestDetails, "commits" | "commentThread">
): PrTimelineEvent[] {
  const events: PrTimelineEvent[] = [
    ...detail.commits.map((c) => ({ kind: "commit" as const, at: c.createdAtMs, commit: c })),
    ...detail.commentThread.map((c) => ({ kind: "comment" as const, at: c.createdAtMs, comment: c })),
  ];
  // Stable sort: a commit and a comment with the same timestamp keep
  // commits-first order, matching the input concatenation above.
  events.sort((a, b) => a.at - b.at);
  return events;
}

// ── Action outcomes ──────────────────────────────────────────────────────────

/** Data the surface re-fetches after an action lands, in order. */
export type GitReviewRefresh = "status" | "log" | "prs" | "stashes";

/** What one successful Git Review action does to the surface. Failures apply
 *  none of it — the runner shows the error notice and stops. */
export type GitActionOutcome = {
  /** Success notice text; also the in-flight action label. */
  message: string;
  refresh: GitReviewRefresh[];
  /** Close the open file diff (back to the history graph). */
  closeDiff?: boolean;
  /** Clear the commit-message field. */
  clearCommitMessage?: boolean;
  /** Close the branch switcher menu. */
  closeBranchMenu?: boolean;
  /** Collapse the expanded PR card (the action consumed it). */
  collapseExpandedPr?: boolean;
  /** Close the PR composer overlay. */
  closePrComposer?: boolean;
};

export function stageFileOutcome(): GitActionOutcome {
  return { message: "Staged", refresh: ["status"] };
}

export function unstageFileOutcome(): GitActionOutcome {
  return { message: "Unstaged", refresh: ["status"] };
}

export function discardFileOutcome(path: string, openPath: string | null): GitActionOutcome {
  // Discarding the file whose diff is open leaves nothing to show.
  return { message: "Discarded", refresh: ["status"], closeDiff: openPath === path };
}

export function stageAllOutcome(): GitActionOutcome {
  return { message: "Staged all", refresh: ["status"] };
}

export function unstageAllOutcome(): GitActionOutcome {
  return { message: "Unstaged all", refresh: ["status"] };
}

export function commitOutcome(): GitActionOutcome {
  return { message: "Committed", refresh: ["status"], clearCommitMessage: true, closeDiff: true };
}

export function fetchOutcome(): GitActionOutcome {
  return { message: "Fetched", refresh: ["log", "prs"] };
}

export function pullOutcome(): GitActionOutcome {
  return { message: "Pulled", refresh: ["log", "status"] };
}

export function pushOutcome(): GitActionOutcome {
  return { message: "Pushed", refresh: ["log", "prs"] };
}

export function checkoutBranchOutcome(name: string): GitActionOutcome {
  // On failure the menu stays open, so the miss is visible where it happened.
  return {
    message: `Switched to ${name}`,
    refresh: ["log", "status"],
    closeBranchMenu: true,
    closeDiff: true,
  };
}

export function stashPushOutcome(): GitActionOutcome {
  return { message: "Stashed", refresh: ["stashes", "status"] };
}

export function stashPopOutcome(): GitActionOutcome {
  return { message: "Stash popped", refresh: ["stashes", "status"] };
}

export function openPrInBrowserOutcome(): GitActionOutcome {
  return { message: "Opened in browser", refresh: [] };
}

export function checkoutPrOutcome(n: number, expandedPr: number | null): GitActionOutcome {
  return {
    message: `Checked out #${n}`,
    refresh: ["log", "status", "prs"],
    collapseExpandedPr: expandedPr === n,
  };
}

export function mergePrOutcome(n: number, expandedPr: number | null): GitActionOutcome {
  return {
    message: `Merged #${n}`,
    refresh: ["prs", "log", "status"],
    collapseExpandedPr: expandedPr === n,
  };
}

export function submitPrOutcome(): GitActionOutcome {
  return { message: "Pull request created", refresh: ["prs"], closePrComposer: true };
}

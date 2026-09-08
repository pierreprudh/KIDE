/** Evidence for one completed attempt, captured by the shared transcript fold.
 * Commands are execution evidence, not a claim that tests or the task passed. */
export type RunCompletion = {
  runId: string;
  completedAt: number;
  outcome: string;
  files: string[];
  commands: { id: string; label: string; status: "passed" | "failed" | "unknown"; output?: string }[];
  warnings: string[];
  /** Files a command left behind — a deck, a PDF, a generated report. Kept
   *  apart from `files` on purpose: these went through no diff review and have
   *  no checkpoint, so they can be opened and read but never reverted, and
   *  presenting them as changes would promise a rollback that does not exist. */
  artifacts?: { path: string; bytes: number; created: boolean }[];
  /** True when the attempt ended without finishing — cancelled, turn cap, or
   *  a provider/harness failure. The edits it applied before stopping are
   *  real files on disk, so the card still opens; it just never presents them
   *  as a result. */
  stopped?: boolean;
};

/** Routine replies and successful read-only work do not need a review entry. */
export function completionDocumentCount(completion: RunCompletion): number {
  return new Set((completion.artifacts ?? []).map((artifact) => artifact.path)).size;
}

export function hasCompletionReview(completion: RunCompletion): boolean {
  return completion.files.length > 0 || completion.warnings.length > 0 ||
    (completion.artifacts?.length ?? 0) > 0 ||
    completion.commands.some((command) => command.status !== "passed");
}

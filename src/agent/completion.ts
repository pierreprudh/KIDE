/** Evidence for one completed attempt, captured by the shared transcript fold.
 * Commands are execution evidence, not a claim that tests or the task passed. */
export type RunCompletion = {
  runId: string;
  completedAt: number;
  outcome: string;
  files: string[];
  commands: { id: string; label: string; status: "passed" | "failed" | "unknown"; output?: string }[];
  warnings: string[];
};

/** Routine replies and successful read-only work do not need a review entry. */
export function hasCompletionReview(completion: RunCompletion): boolean {
  return completion.files.length > 0 || completion.warnings.length > 0 ||
    completion.commands.some((command) => command.status !== "passed");
}

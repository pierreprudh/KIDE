// Default run isolation — one fresh Git worktree per independent Run.
//
// The Rust git module owns the checkout mechanics and setup recipe. This file
// owns the product policy shared by the AI-panel and Mission Control launch
// paths: stable branch naming, display metadata, and the one legitimate local
// fallback (a folder that is not a Git repository).

import { gitWorktreeAdd } from "./ipc/git";
import { worktreeName, type WorktreeInfo } from "./worktrees";

export type IsolatedRunWorkspace = {
  baseRoot: string;
  cwd: string;
  branch: string;
  worktree: string;
  setup: WorktreeInfo;
};

function branchSlug(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 36) || "task";
}

/** A readable, collision-resistant branch for a Klide-created Run. */
export function isolatedRunBranch(
  kind: "run" | "task",
  title: string,
  identity: string,
): string {
  const suffix = identity.toLowerCase().replace(/[^a-z0-9]/g, "").slice(-8) || "run";
  return `klide/${kind}-${branchSlug(title)}-${suffix}`;
}

/** Git's error text differs slightly by platform/version; keep the fallback
 * deliberately narrow so a real worktree/setup failure never silently sends
 * an agent into the main checkout. */
export function isNotGitRepositoryError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /not (?:inside )?a git repository|not a git repository/i.test(message);
}

export async function createIsolatedRunWorkspace(opts: {
  baseRoot: string;
  kind: "run" | "task";
  title: string;
  identity: string;
}): Promise<IsolatedRunWorkspace> {
  const branch = isolatedRunBranch(opts.kind, opts.title, opts.identity);
  const setup = await gitWorktreeAdd(opts.baseRoot, branch);
  return {
    baseRoot: opts.baseRoot,
    cwd: setup.path,
    branch: setup.branch,
    worktree: worktreeName(setup),
    setup,
  };
}

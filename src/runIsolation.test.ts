import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import {
  createIsolatedRunWorkspace,
  isolatedRunBranch,
  isNotGitRepositoryError,
} from "./runIsolation";

beforeEach(() => invokeMock.mockReset());

describe("default Run isolation", () => {
  it("builds readable, bounded Git branch names", () => {
    expect(isolatedRunBranch("task", "Fix the flaky checkout!", "task-ABC-123456789")).toBe(
      "klide/task-fix-the-flaky-checkout-23456789",
    );
    expect(isolatedRunBranch("run", "✨", "---")).toBe("klide/run-task-run");
  });

  it("creates the checkout and returns the metadata every run surface needs", async () => {
    invokeMock.mockResolvedValue({
      path: "/repo-worktrees/klide-run-fix-tests-c0ffee12",
      branch: "klide/run-fix-tests-c0ffee12",
      bootstrapped: [".env"],
    });

    const isolated = await createIsolatedRunWorkspace({
      baseRoot: "/repo",
      kind: "run",
      title: "Fix tests",
      identity: "c0ffee12",
    });

    expect(invokeMock).toHaveBeenCalledWith("git_worktree_add", {
      workspaceRoot: "/repo",
      branch: "klide/run-fix-tests-c0ffee12",
      copyFiles: null,
    });
    expect(isolated).toMatchObject({
      baseRoot: "/repo",
      cwd: "/repo-worktrees/klide-run-fix-tests-c0ffee12",
      branch: "klide/run-fix-tests-c0ffee12",
      worktree: "klide-run-fix-tests-c0ffee12",
    });
  });

  it("recognizes only the non-Git failure that may fall back to local", () => {
    expect(isNotGitRepositoryError(new Error("fatal: not a git repository"))).toBe(true);
    expect(isNotGitRepositoryError("Not inside a git repository")).toBe(true);
    expect(isNotGitRepositoryError(new Error("worktree setup failed"))).toBe(false);
  });
});

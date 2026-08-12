import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DELEGATE_IDS } from "./delegates";
import { memoryStorage } from "./testStorage";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(async () => () => {}),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

beforeEach(() => {
  vi.resetModules();
  invokeMock.mockReset();
  vi.stubGlobal("localStorage", memoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("task Delegate persistence", () => {
  it("hydrates every supported Delegate without losing its source", async () => {
    localStorage.setItem(
      "klide.tasks",
      JSON.stringify(
        DELEGATE_IDS.map((source, index) => ({
          id: `task-${source}`,
          title: `Task ${index + 1}`,
          source,
          model: null,
          status: "done",
          cwd: "/workspace",
          startedMs: index,
        })),
      ),
    );

    const { getTaskSessions } = await import("./tasks");
    expect(getTaskSessions().map((task) => task.source)).toEqual([...DELEGATE_IDS].reverse());
  });

  it("accepts every supported Delegate as the last-used agent", async () => {
    const { lastAgent } = await import("./tasks");

    for (const source of DELEGATE_IDS) {
      localStorage.setItem("klide-last-agent", source);
      expect(lastAgent()).toBe(source);
    }

    localStorage.setItem("klide-last-agent", "removed-delegate");
    expect(lastAgent()).toBe("claude-code");
  });

  it("dispatches a new task in an isolated worktree", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "git_worktree_add") {
        return {
          path: "/workspace-worktrees/task-fix-tests",
          branch: "klide/task-fix-tests-12345678",
          bootstrapped: [],
        };
      }
      return undefined;
    });
    const { addTask, dispatchTask, getTaskSessions } = await import("./tasks");
    const task = addTask("Fix tests", "/workspace");

    await dispatchTask(task.id, "codex", "gpt-5");

    expect(invokeMock).toHaveBeenCalledWith(
      "delegate_pty_spawn",
      expect.objectContaining({ workspaceRoot: "/workspace-worktrees/task-fix-tests" }),
    );
    expect(getTaskSessions()[0]).toMatchObject({
      workspaceRoot: "/workspace",
      cwd: "/workspace-worktrees/task-fix-tests",
      branch: "klide/task-fix-tests-12345678",
      worktree: "task-fix-tests",
      status: "running",
    });
  });

  it("uses the local folder only when it is not a Git repository", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "git_worktree_add") throw new Error("fatal: not a git repository");
      return undefined;
    });
    const { addTask, dispatchTask } = await import("./tasks");
    const task = addTask("Draft notes", "/notes");

    await dispatchTask(task.id, "claude-code");

    expect(invokeMock).toHaveBeenCalledWith(
      "delegate_pty_spawn",
      expect.objectContaining({ workspaceRoot: "/notes" }),
    );
  });

  it("cleans up a newly-created checkout when the delegate fails to launch", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "git_worktree_add") {
        return {
          path: "/workspace-worktrees/task-broken",
          branch: "klide/task-broken-deadbeef",
          bootstrapped: [".env"],
        };
      }
      if (command === "delegate_pty_spawn") throw new Error("CLI unavailable");
      return undefined;
    });
    const { addTask, dispatchTask, getTaskSessions } = await import("./tasks");
    const task = addTask("Broken", "/workspace");

    await expect(dispatchTask(task.id, "codex")).rejects.toThrow("CLI unavailable");

    expect(invokeMock).toHaveBeenCalledWith("git_worktree_remove", {
      workspaceRoot: "/workspace",
      path: "/workspace-worktrees/task-broken",
      force: false,
      cleanFiles: [".env"],
      deleteBranch: "klide/task-broken-deadbeef",
    });
    expect(getTaskSessions()[0]).toMatchObject({
      status: "error",
      workspaceRoot: "/workspace",
      cwd: "/workspace",
      branch: null,
      worktree: null,
    });
  });
});

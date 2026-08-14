// Delegated tasks — Mission Control's todo list (Devin-style). A task starts
// life as a queued todo; "send an agent" dispatches a delegate CLI (claude /
// codex) that works on it async in the workspace while you observe / take
// over / stop. State lives at module level rather than in React so a running
// task survives switching views — the PTY on the Rust side outlives any
// component. Mission Control reads this store via useSyncExternalStore.

import { onDelegateExit, spawnDelegatePty, stopDelegatePty } from "./ipc/delegatePty";
import { gitWorktreeRemove } from "./ipc/git";
import { createPersistedStore, validatedArray } from "./persistedStore";
import type { RunStatus } from "./runs";
import { isDelegateId, type DelegateId } from "./delegates";
import {
  createIsolatedRunWorkspace,
  isNotGitRepositoryError,
  type IsolatedRunWorkspace,
} from "./runIsolation";

// Every delegate can be dispatched to a task. Derives from the one delegate
// list so a new delegate is offerable without editing this file.
export type TaskSource = DelegateId;

export type TaskSession = {
  id: string;
  title: string;
  // null until an agent is sent — a plain todo wears the Klide mark.
  source: TaskSource | null;
  // The model the user picked in the dispatch dropdown. null when undispatched
  // or when the caller didn't pass a model (the CLI falls back to its own
  // default in that case). Persisted on the session so the detail pane can
  // re-show what the run was launched with.
  model: string | null;
  status: RunStatus;
  /** The project checkout the task was created from. `cwd` moves to the
   *  isolated checkout once an agent is dispatched. */
  workspaceRoot: string | null;
  cwd: string | null;
  branch: string | null;
  worktree: string | null;
  startedMs: number;
};

const TASKS_KEY = "klide.tasks";
const MAX_TASKS = 100;

function isRunStatus(value: unknown): value is RunStatus {
  return (
    value === "running" ||
    value === "waiting" ||
    value === "queued" ||
    value === "done" ||
    value === "cancelled" ||
    value === "error"
  );
}

function safeStatus(status: unknown): RunStatus {
  // PTY sessions are process-local. After an app restart, a previously
  // running task is only a durable work record, not a live terminal.
  if (status === "running" || status === "waiting") return "done";
  return isRunStatus(status) ? status : "queued";
}

function safeSource(source: unknown): TaskSource | null {
  return typeof source === "string" && isDelegateId(source) ? source : null;
}

const store = createPersistedStore<TaskSession[]>({
  key: TASKS_KEY,
  validate: (parsed) =>
    validatedArray(
      parsed,
      (task): task is Partial<TaskSession> & { id: string; title: string } =>
        !!task &&
        typeof task === "object" &&
        typeof (task as Partial<TaskSession>).id === "string" &&
        typeof (task as Partial<TaskSession>).title === "string",
    )
      .map((task) => ({
        id: task.id,
        title: task.title,
        source: safeSource(task.source),
        model: typeof task.model === "string" ? task.model : null,
        status: safeStatus(task.status),
        workspaceRoot:
          typeof task.workspaceRoot === "string"
            ? task.workspaceRoot
            : typeof task.cwd === "string"
              ? task.cwd
              : null,
        cwd: typeof task.cwd === "string" ? task.cwd : null,
        branch: typeof task.branch === "string" ? task.branch : null,
        worktree: typeof task.worktree === "string" ? task.worktree : null,
        startedMs: typeof task.startedMs === "number" ? task.startedMs : Date.now(),
      }))
      .sort((a, b) => b.startedMs - a.startedMs)
      .slice(0, MAX_TASKS),
  bound: (tasks) => tasks.slice(0, MAX_TASKS),
});

// Session ids this module dispatched, so the app-wide exit event only flips
// tasks we own (the AI panel runs its own delegates through the same PTY).
// This used to also hold a copy of each session's output for replay; Rust's
// scrollback is the authority for that and carries the `seq` the replay
// handshake needs, so the terminal reads it via `attachDelegatePty` instead.
const dispatched = new Set<string>();

function patch(id: string, fields: Partial<TaskSession>) {
  if (!store.get().some((s) => s.id === id)) return;
  store.mutate((sessions) => sessions.map((s) => (s.id === id ? { ...s, ...fields } : s)));
}

// One app-wide listener, attached lazily on first use: the exit event is what
// flips a task from running → done. There used to be a second listener here
// maintaining a replay buffer, which meant every PTY chunk in the app paid for
// a string concat (and a 200 KB slice once the buffer filled) to feed something
// only one terminal read. The terminal now replays from Rust's snapshot.
let wired = false;
function wire() {
  if (wired) return;
  wired = true;
  void onDelegateExit(({ sessionId }) => {
    // Ignore sessions we didn't dispatch (e.g. the AI panel's own delegates).
    if (dispatched.has(sessionId)) patch(sessionId, { status: "done", startedMs: Date.now() });
  });
}

export function subscribeTasks(fn: () => void): () => void {
  wire();
  return store.subscribe(fn);
}

export function getTaskSessions(): TaskSession[] {
  return store.get();
}

// The agent used for the previous dispatch — quick-send defaults to it so
// landing an agent on a todo is one click.
export function lastAgent(): TaskSource {
  const stored = localStorage.getItem("klide-last-agent");
  return stored && isDelegateId(stored) ? stored : "claude-code";
}

// The model last used for a given source, persisted separately per source so
// switching from Claude Sonnet to Codex gpt-5.4 to OpenCode minimax-m3 lands
// each new dispatch on the right model. Empty string means "let the CLI pick".
export function lastModel(source: TaskSource): string {
  return localStorage.getItem(`klide-last-model-${source}`) ?? "";
}

// Add a todo. Nothing runs yet — it sits in Queued until an agent is sent.
export function addTask(title: string, workspaceRoot: string | null): TaskSession {
  wire();
  const task: TaskSession = {
    id: crypto.randomUUID(),
    title,
    source: null,
    model: null,
    status: "queued",
    workspaceRoot,
    cwd: workspaceRoot,
    branch: null,
    worktree: null,
    startedMs: Date.now(),
  };
  store.mutate((sessions) => [task, ...sessions]);
  return task;
}

export async function startTask(
  source: TaskSource,
  title: string,
  workspaceRoot: string | null
): Promise<TaskSession> {
  const task = addTask(title, workspaceRoot);
  await dispatchTask(task.id, source);
  return getTaskSessions().find((s) => s.id === task.id) ?? task;
}

// Send an agent to a todo: spawn the delegate CLI in the task's workspace with
// the todo text as its first prompt. `model` is optional — the Rust side
// skips the model flag when None so each CLI falls back to its own default.
// Flips queued → running; on failure the task flips to error (and can be
// re-dispatched).
export async function dispatchTask(
  id: string,
  source: TaskSource,
  model?: string
): Promise<void> {
  const task = store.get().find((s) => s.id === id);
  if (!task || task.status === "running") return;
  localStorage.setItem("klide-last-agent", source);
  // Only persist non-empty selections so a quick-send with no model chosen
  // doesn't clobber a previously-saved preference.
  if (model && model.trim()) {
    localStorage.setItem(`klide-last-model-${source}`, model.trim());
  }
  // Claim the task before awaiting worktree creation. Quick-send and the
  // detail action can otherwise race two dispatches while Git is preparing
  // the same deterministic branch.
  dispatched.add(id);
  patch(id, {
    source,
    model: model && model.trim() ? model.trim() : null,
    status: "running",
    startedMs: Date.now(),
  });
  let launchTask = task;
  let isolated: IsolatedRunWorkspace | null = null;
  // A re-dispatch reuses the checkout it already owns. A first dispatch gets
  // a fresh branch before the CLI starts, so no agent mutation can land in
  // the main checkout. Non-Git folders are the sole local fallback.
  if (task.workspaceRoot && !task.worktree) {
    try {
      isolated = await createIsolatedRunWorkspace({
        baseRoot: task.workspaceRoot,
        kind: "task",
        title: task.title,
        identity: task.id,
      });
      launchTask = {
        ...task,
        cwd: isolated.cwd,
        branch: isolated.branch,
        worktree: isolated.worktree,
      };
      patch(id, {
        cwd: isolated.cwd,
        branch: isolated.branch,
        worktree: isolated.worktree,
      });
    } catch (err) {
      if (!isNotGitRepositoryError(err)) {
        patch(id, { status: "error" });
        throw err;
      }
    }
  }
  try {
    await spawnDelegatePty(id, {
      provider: source,
      workspaceRoot: launchTask.cwd,
      task: launchTask.title,
      model: model && model.trim() ? model.trim() : null,
      parentRunId: id, // task is its own parent (task spawns delegate with same session id)
    });
  } catch (err) {
    patch(id, { status: "error" });
    // The CLI never started, so remove the checkout this attempt created.
    // Refuse force: if anything else wrote there, preserve it and retain its
    // metadata on the task so the work remains reachable.
    if (isolated) {
      try {
        await gitWorktreeRemove(isolated.baseRoot, isolated.cwd, {
          cleanFiles: isolated.setup.bootstrapped,
          deleteBranch: isolated.branch,
        });
        patch(id, {
          cwd: isolated.baseRoot,
          branch: null,
          worktree: null,
        });
      } catch {
        // Preserve the isolated checkout + original error for manual recovery.
      }
    }
    throw err;
  }
}

// Interrupt a running task (Ctrl-C + exit on the Rust side). The PTY exit
// event confirms the flip to done; we set it eagerly so the UI reacts at once.
export async function stopTask(id: string): Promise<void> {
  await stopDelegatePty(id);
  patch(id, { status: "done" });
}

export function renameTask(id: string, title: string): void {
  const nextTitle = title.trim();
  if (!nextTitle) return;
  patch(id, { title: nextTitle });
}

// Drop a task off the board (todos you no longer want, finished runs).
// Running tasks must be stopped first.
export function removeTask(id: string): void {
  const task = store.get().find((s) => s.id === id);
  if (!task || task.status === "running") return;
  store.mutate((sessions) => sessions.filter((s) => s.id !== id));
  dispatched.delete(id);
}

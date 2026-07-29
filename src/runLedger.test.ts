import { describe, expect, it } from "vitest";
import {
  buildRunLedger,
  presentProjects,
  projectMatchesFilter,
  runLedgerKey,
  type RunLedgerMetadataStore,
} from "./runLedger";
import type { Run } from "./runs";
import type { KlideConvo } from "./klideConvos";
import type { TaskSession } from "./tasks";

const ROOT = "/Users/pierre/Documents/Private/KIDE";

function diskRun(over: Partial<Run> = {}): Run {
  return {
    id: "r1",
    path: `/runs/r1.jsonl`,
    source: "klide",
    kind: "run",
    title: "On-disk run",
    status: "done",
    model: "qwen2.5:7b",
    project: "KIDE",
    cwd: ROOT,
    branch: null,
    messageCount: 6,
    updatedMs: 2_000,
    createdMs: 1_000,
    ...over,
  };
}

function convo(over: Partial<KlideConvo> = {}): KlideConvo {
  return {
    id: "c1",
    title: "Live convo",
    status: "running",
    model: "qwen2.5:7b",
    cwd: ROOT,
    branch: null,
    messages: [],
    updatedMs: 3_000,
    ...over,
  };
}

function task(over: Partial<TaskSession> = {}): TaskSession {
  return {
    id: "t1",
    title: "Delegated todo",
    source: null,
    model: null,
    status: "queued",
    cwd: ROOT,
    startedMs: 500,
    ...over,
  };
}

function build(over: Partial<Parameters<typeof buildRunLedger>[0]> = {}) {
  return buildRunLedger({ tasks: [], convos: [], runs: [], workspaceRoot: ROOT, ...over });
}

describe("buildRunLedger", () => {
  it("drops a live convo once its on-disk twin exists", () => {
    // A Klide convo id IS its transcript id, so a settled run appears twice —
    // once from the in-memory convo store, once from disk. The on-disk copy
    // wins because it carries the enriched summary (tokens, validation).
    const entries = build({
      convos: [convo({ id: "shared", title: "from convo" })],
      runs: [diskRun({ id: "shared", title: "from disk" })],
    });

    expect(entries).toHaveLength(1);
    expect(entries[0].title).toBe("from disk");
    expect(entries[0].origin).toBe("transcript");
  });

  it("keeps a live convo that has no twin yet", () => {
    const entries = build({ convos: [convo({ id: "fresh" })] });
    expect(entries.map((e) => e.origin)).toEqual(["klide-convo"]);
  });

  it("hides convos belonging to another workspace but keeps cwd-less ones", () => {
    const entries = build({
      convos: [
        convo({ id: "here", cwd: ROOT }),
        convo({ id: "elsewhere", cwd: "/Users/pierre/Documents/Other" }),
        convo({ id: "no-cwd", cwd: null }),
      ],
    });
    expect(entries.map((e) => e.id).sort()).toEqual(["here", "no-cwd"]);
  });

  it("orders tasks, then live convos, then disk runs", () => {
    const entries = build({
      tasks: [task({ id: "t" })],
      convos: [convo({ id: "c" })],
      runs: [diskRun({ id: "r" })],
    });
    expect(entries.map((e) => e.id)).toEqual(["t", "c", "r"]);
  });

  it("applies a renamed title without losing the original", () => {
    const run = diskRun();
    const metadata: RunLedgerMetadataStore = {
      [runLedgerKey(run)]: { title: "  My name for it  " },
    };
    const [entry] = build({ runs: [run], metadata });
    expect(entry.title).toBe("My name for it");
    expect(entry.originalTitle).toBe("On-disk run");

    // A rename cleared to whitespace falls back to the parsed title rather
    // than leaving a blank row.
    const blank: RunLedgerMetadataStore = { [runLedgerKey(run)]: { title: "   " } };
    expect(build({ runs: [run], metadata: blank })[0].title).toBe("On-disk run");
  });

  it("hides archived entries unless asked for them", () => {
    const run = diskRun();
    const metadata: RunLedgerMetadataStore = { [runLedgerKey(run)]: { archived: true } };
    expect(build({ runs: [run], metadata })).toHaveLength(0);
    const [entry] = build({ runs: [run], metadata, showArchived: true });
    expect(entry.archived).toBe(true);
  });

  it("dismisses board runs but never a task", () => {
    // Tasks are explicit assignments the user created; dismissing is for
    // finished agent runs cluttering the board, so it must not swallow a todo.
    const entries = build({
      tasks: [task({ id: "t1" })],
      runs: [diskRun({ id: "r1" })],
      dismissedBoardRuns: new Set(["klide:t1", "klide:r1"]),
      dismissKey: runLedgerKey,
    });
    expect(entries.map((e) => e.id)).toEqual(["t1"]);
  });

  it("gives every delegate the same resume and terminal capabilities", () => {
    // The board used to hardcode claude-code || codex || opencode in three
    // places, so omp runs silently lost their resume affordance. Capabilities
    // come off `isDelegateId` instead, which covers all four.
    for (const source of ["claude-code", "codex", "opencode", "omp"] as const) {
      const [entry] = build({ runs: [diskRun({ source })] });
      expect(entry.capabilities.canResume, source).toBe(true);
      expect(entry.capabilities.canOpenTerminal, source).toBe(true);
      // Evidence packets render from Klide's own AgentEvent transcript only.
      expect(entry.capabilities.canExportEvidence, source).toBe(false);
    }

    const [klide] = build({ runs: [diskRun({ source: "klide" })] });
    expect(klide.capabilities.canResume).toBe(true);
    expect(klide.capabilities.canExportEvidence).toBe(true);
  });

  it("withholds rename and archive while a run is still active", () => {
    const [running] = build({ runs: [diskRun({ status: "running" })] });
    expect(running.capabilities.canRename).toBe(false);
    expect(running.capabilities.canArchive).toBe(false);

    const [done] = build({ runs: [diskRun({ status: "done" })] });
    expect(done.capabilities.canRename).toBe(true);
    expect(done.capabilities.canArchive).toBe(true);
  });

  it("marks a finished task as needing review, not done", () => {
    const [entry] = build({ tasks: [task({ status: "done" })] });
    expect(entry.lifecycle).toBe("needs_review");
  });
});

describe("projectMatchesFilter", () => {
  it("matches the current workspace by cwd even when the parsed project is missing", () => {
    const run = {
      project: null,
      cwd: "/Users/pierre/Documents/Private/KIDE",
    };

    expect(projectMatchesFilter(run, "KIDE", "/Users/pierre/Documents/Private/KIDE")).toBe(true);
  });

  it("matches by cwd basename as a fallback for stale project strings", () => {
    const run = {
      project: "Private",
      cwd: "/Users/pierre/Documents/Private/KIDE",
    };

    expect(projectMatchesFilter(run, "KIDE", "/Users/pierre/Documents/Private/KIDE")).toBe(true);
  });

  it("matches runs executing in a linked worktree of the filtered project", () => {
    // Races and worktree forks run in `<repo>-worktrees/<name>` — they must
    // stay visible under the default current-project filter.
    const run = {
      project: null,
      cwd: "/Users/pierre/Documents/Private/KIDE-worktrees/race-m3abc-1",
    };

    expect(projectMatchesFilter(run, "KIDE", "/Users/pierre/Documents/Private/KIDE")).toBe(true);
  });

  it("does not leak another project's worktree runs into the filter", () => {
    const run = {
      project: null,
      cwd: "/Users/pierre/Documents/Other-worktrees/race-m3abc-1",
    };

    expect(projectMatchesFilter(run, "KIDE", "/Users/pierre/Documents/Private/KIDE")).toBe(false);
  });
});

describe("presentProjects", () => {
  it("includes projects recoverable from cwd", () => {
    expect(presentProjects([{ project: null, cwd: "/Users/pierre/Documents/Private/KIDE" }])).toEqual(["KIDE"]);
  });
});

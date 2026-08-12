import type { KlideConvo } from "./klideConvos";
import {
  boardSectionForRun,
  runLifecycleStatus,
  type Run,
  type RunBoardSection,
  type RunLifecycleStatus,
  type RunSource,
} from "./runs";
import type { TaskSession, TaskSource } from "./tasks";
import { DELEGATE_IDS, isDelegateId } from "./delegates";
import { normalizeProjectPath, pathBelongsToProject } from "./projectPaths";

export type RunLedgerOrigin = "task" | "klide-convo" | "transcript";

export type RunLedgerEntry = Run & {
  origin: RunLedgerOrigin;
  lifecycle: RunLifecycleStatus;
  capabilities: RunCapabilities;
  archived: boolean;
  originalTitle: string;
};

export type RunCapabilities = {
  canRename: boolean;
  canResume: boolean;
  /** No consumer yet. Kept because it is the flag a "reattach the CLI" action
   *  on a board row would ask for, and the rule (a delegate run, or a task that
   *  dispatched one) is already worked out and tested. Delete it if that action
   *  is dropped rather than letting it drift. */
  canOpenTerminal: boolean;
  canOpenInOtherAgent: boolean;
  canReviewDiff: boolean;
  canSaveMemory: boolean;
  canFork: boolean;
  canArchive: boolean;
  canExportTranscript: boolean;
  /** Export a Markdown evidence packet — Klide-native runs only, since the
   *  packet is rendered from the on-disk AgentEvent transcript. */
  canExportEvidence: boolean;
};

const NO_CAPABILITIES: RunCapabilities = {
  canRename: false,
  canResume: false,
  canOpenTerminal: false,
  canOpenInOtherAgent: false,
  canReviewDiff: false,
  canSaveMemory: false,
  canFork: false,
  canArchive: false,
  canExportTranscript: false,
  canExportEvidence: false,
};

export type RunLedgerMetadata = {
  title?: string;
  archived?: boolean;
  updatedMs?: number;
};

export type RunLedgerMetadataStore = Record<string, RunLedgerMetadata>;

const LEDGER_METADATA_KEY = "klide.runLedger.metadata";

export function runLedgerKey(run: Pick<Run, "source" | "id">): string {
  return `${run.source}:${run.id}`;
}

export function readRunLedgerMetadata(): RunLedgerMetadataStore {
  try {
    const raw = localStorage.getItem(LEDGER_METADATA_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: RunLedgerMetadataStore = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const meta = value as Partial<RunLedgerMetadata>;
      out[key] = {
        title: typeof meta.title === "string" && meta.title.trim() ? meta.title : undefined,
        archived: typeof meta.archived === "boolean" ? meta.archived : undefined,
        updatedMs: typeof meta.updatedMs === "number" ? meta.updatedMs : undefined,
      };
    }
    return out;
  } catch {
    return {};
  }
}

export function writeRunLedgerMetadata(store: RunLedgerMetadataStore): void {
  try {
    localStorage.setItem(LEDGER_METADATA_KEY, JSON.stringify(store));
  } catch {
    /* storage full or unavailable */
  }
}

/**
 * The project a run belongs to: the basename of its working directory. Shared
 * by ledger construction (per-run `project`) and Mission Control's project
 * filter so the dropdown's "current project" default matches run labels exactly.
 */
export function projectName(cwd: string | null): string | null {
  return cwd ? cwd.split("/").filter(Boolean).pop() ?? null : null;
}

/**
 * Claude Code's own sub-agent transcripts, which it writes to
 * `<parent>/subagents/<agent>.jsonl`. They are turns inside the parent session,
 * not sessions of their own, so there is no id to `--resume`.
 *
 * The path layout is Rust's to know (`claude_subagent_parent_id` in
 * `delegate/claude_code.rs` derives `parentId` from exactly this shape), and
 * CONTEXT.md reserves transcript parsing for the Delegate seam. Until Rust
 * carries the distinction on the wire, the duplicate lives here — one place
 * that a test covers — rather than inline in a React component.
 */
export function isClaudeInternalSubagent(run: Pick<Run, "source" | "path">): boolean {
  return run.source === "claude-code" && run.path.includes("/subagents/");
}

function capabilitiesFor(run: Run, origin: RunLedgerOrigin, lifecycle = runLifecycleStatus(run)): RunCapabilities {
  const delegate = isDelegateId(run.source);
  const hasContent = run.kind === "convo" || run.kind === "run";
  const hasWorkspace = !!run.cwd;
  const active = lifecycle === "running" || lifecycle === "waiting";
  return {
    ...NO_CAPABILITIES,
    canRename: !active,
    // The conditions for resuming, in one place. The board and the detail pane
    // spelled these out four different ways between them; what legitimately
    // differs is only which affordance a source routes to ("Resume in Klide"
    // vs "Open in {CLI}"), so callers still check `source` — they just no
    // longer restate when a resume is possible.
    //
    // `kind === "run"` means an on-disk transcript exists. A convo-origin entry
    // is one the ledger found no disk twin for, so there is nothing to continue
    // from. Raw `status` rather than lifecycle, so a delegate blocked on input
    // (`waiting`) can still be reattached — that is the main reason to resume one.
    canResume:
      run.kind === "run" &&
      run.status !== "running" &&
      (run.source === "klide" || (delegate && !isClaudeInternalSubagent(run))),
    canOpenTerminal: delegate || origin === "task",
    canOpenInOtherAgent: run.source === "klide" || delegate,
    canReviewDiff: hasWorkspace && lifecycle !== "queued",
    canSaveMemory: hasContent,
    canFork: hasContent,
    canArchive: !active,
    canExportTranscript: hasContent,
    canExportEvidence: run.source === "klide" && hasContent,
  };
}

function withCapabilities(
  run: Run,
  origin: RunLedgerOrigin,
  metadata: RunLedgerMetadataStore = {},
): RunLedgerEntry {
  const meta = metadata[runLedgerKey(run)];
  const title = meta?.title?.trim() || run.title;
  const lifecycle = runLifecycleStatus(run);
  return {
    ...run,
    title,
    lifecycle,
    originalTitle: run.title,
    origin,
    archived: meta?.archived === true,
    capabilities: capabilitiesFor(run, origin, lifecycle),
  };
}

function taskToLedgerEntry(
  t: TaskSession,
  metadata?: RunLedgerMetadataStore,
): RunLedgerEntry {
  const run: Run = {
    id: t.id,
    path: "",
    kind: "task",
    source: t.source ?? "klide",
    title: t.title,
    status: t.status,
    model: t.model,
    project: projectName(t.workspaceRoot ?? t.cwd),
    cwd: t.cwd,
    branch: t.branch,
    worktree: t.worktree,
    messageCount: 0,
    updatedMs: t.startedMs,
    createdMs: t.startedMs,
  };
  return withCapabilities(run, "task", metadata);
}

// "What it last did" for a live convo, mirroring the Rust transcript's
// `last_assistant_summary`: the newest assistant turn's first non-empty line,
// capped at 120 chars. Lets a mid-run convo show the same evidence line as its
// on-disk twin instead of going blank until the run settles to disk.
function convoLastEvent(messages: KlideConvo["messages"]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== "assistant") continue;
    const line = m.text.split("\n").find((l) => l.trim().length > 0)?.trim();
    if (line) return line.slice(0, 120);
  }
  return undefined;
}

function convoToLedgerEntry(
  c: KlideConvo,
  metadata?: RunLedgerMetadataStore,
): RunLedgerEntry {
  const run: Run = {
    id: c.id,
    path: "",
    kind: "convo",
    source: "klide",
    title: c.title,
    status: c.status,
    provider: c.provider ?? null,
    model: c.model,
    project: projectName(c.cwd),
    cwd: c.cwd,
    branch: c.branch ?? null,
    worktree: c.worktree ?? null,
    forkedFrom: c.forkedFrom ?? null,
    messageCount: c.messages?.length ?? 0,
    lastEvent: convoLastEvent(c.messages ?? []),
    updatedMs: c.updatedMs,
    createdMs: c.createdMs ?? c.updatedMs,
  };
  return withCapabilities(run, "klide-convo", metadata);
}

function transcriptToLedgerEntry(
  run: Run,
  metadata?: RunLedgerMetadataStore,
): RunLedgerEntry {
  return withCapabilities(run, "transcript", metadata);
}

export type BuildRunLedgerInput = {
  tasks: TaskSession[];
  convos: KlideConvo[];
  runs: Run[];
  workspaceRoot: string | null;
  dismissedBoardRuns?: Set<string>;
  dismissKey?: (run: Run) => string;
  metadata?: RunLedgerMetadataStore;
  showArchived?: boolean;
};

export function buildRunLedger({
  tasks,
  convos,
  runs,
  workspaceRoot,
  dismissedBoardRuns,
  dismissKey,
  metadata = {},
  showArchived = false,
}: BuildRunLedgerInput): RunLedgerEntry[] {
  const workspaceConvos = convos.filter((c) => !workspaceRoot || !c.cwd || c.cwd === workspaceRoot);
  const diskIds = new Set(runs.map((r) => r.id));
  const entries = [
    ...tasks.map((task) => taskToLedgerEntry(task, metadata)),
    ...workspaceConvos.map((convo) => convoToLedgerEntry(convo, metadata)).filter((c) => !diskIds.has(c.id)),
    ...runs.map((run) => transcriptToLedgerEntry(run, metadata)),
  ].filter((entry) => showArchived || !entry.archived);
  if (!dismissedBoardRuns || !dismissKey) return entries;
  return entries.filter((r) => r.kind === "task" || !dismissedBoardRuns.has(dismissKey(r)));
}

export type RunSourceFilter = RunSource | "all" | "subagent";

function sourceMatchesFilter(run: Pick<RunLedgerEntry, "source">, filter: RunSourceFilter): boolean {
  if (filter === "all") return true;
  if (filter === "subagent") return isDelegateId(run.source);
  return run.source === filter;
}

export function presentRunSources(entries: Pick<RunLedgerEntry, "source">[]): RunSource[] {
  const set = new Set<RunSource>();
  for (const entry of entries) set.add(entry.source);
  return Array.from(set);
}

export type ProjectFilter = string | "all";

export function projectMatchesFilter(
  run: Pick<RunLedgerEntry, "project" | "cwd">,
  filter: ProjectFilter,
  workspaceRoot?: string | null,
): boolean {
  if (filter === "all") return true;
  const workspace = normalizeProjectPath(workspaceRoot ?? null);
  const runCwd = normalizeProjectPath(run.cwd);
  if (
    workspace &&
    runCwd &&
    filter === projectName(workspace) &&
    pathBelongsToProject(runCwd, workspace)
  ) {
    return true;
  }
  if (projectName(run.cwd) === filter) return true;
  // A run in a linked worktree belongs to its parent project: worktrees are
  // created as siblings under `<repo>-worktrees/<name>` (git worktree_add).
  // Without this, races/forks running in worktrees vanish from the default
  // current-project board.
  const segments = runCwd?.split("/") ?? [];
  const parentDir = segments.length >= 2 ? segments[segments.length - 2] : null;
  if (parentDir === `${filter}-worktrees`) return true;
  return run.project === filter;
}

/** Unique, sorted project names present across the given runs (skips unscoped runs). */
export function presentProjects(entries: Pick<RunLedgerEntry, "project" | "cwd">[]): string[] {
  const set = new Set<string>();
  for (const entry of entries) {
    const name = entry.project ?? projectName(entry.cwd);
    if (name) set.add(name);
  }
  return Array.from(set).sort((a, b) => a.localeCompare(b));
}

export function handoffTargetsFor(run: Pick<RunLedgerEntry, "source">): TaskSource[] {
  return DELEGATE_IDS.filter((source) => source !== run.source);
}

export function runMatchesLedgerQuery(run: RunLedgerEntry, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const fields = [
    run.id,
    run.title,
    run.source,
    run.origin,
    run.status,
    run.lifecycle,
    run.kind,
    run.model,
    run.provider,
    run.project,
    run.cwd,
    run.branch,
    run.worktree,
    run.forkedFrom?.title,
    run.forkedFrom?.mode,
    run.forkedFrom ? `message ${run.forkedFrom.messageIndex + 1}` : null,
    run.lastEvent,
    run.archived ? "archived" : null,
  ];
  return fields.some((field) => field?.toLowerCase().includes(q));
}

// ── The board model ──────────────────────────────────────────────────────────
// Mission Control's rows are a filter, a grouping, a race index and a
// parent→child index over the ledger. All four used to live inside the
// component — two of them inside a render IIFE — so none could be exercised
// without mounting React, and the deep module they belong to got bypassed.
// They are pure functions of their inputs; they belong here.

/** A run's race membership, precomputed for the board rows. */
export type RaceRowInfo = {
  groupId: string;
  memberIndex: number;
  /** "A", "B", … — the member's stable letter within its race. */
  label: string;
  size: number;
  prompt: string;
};

/** runId → race membership, for every group in the store. */
export function buildRaceRowIndex(
  groups: { id: string; prompt: string; members: { runId: string }[] }[],
): Map<string, RaceRowInfo> {
  const map = new Map<string, RaceRowInfo>();
  for (const group of groups) {
    group.members.forEach((member, memberIndex) => {
      map.set(member.runId, {
        groupId: group.id,
        memberIndex,
        label: String.fromCharCode(65 + memberIndex),
        size: group.members.length,
        prompt: group.prompt,
      });
    });
  }
  return map;
}

/** Keep race siblings adjacent within a section: the first-seen member of a
 *  group pulls the rest up next to it (in member order), so a race reads as one
 *  comparison block instead of scattered rows. Non-members keep their recency
 *  order. */
export function clusterRaceRows(
  rows: RunLedgerEntry[],
  info: Map<string, RaceRowInfo>,
): RunLedgerEntry[] {
  if (info.size === 0) return rows;
  const out: RunLedgerEntry[] = [];
  const emitted = new Set<string>();
  for (const row of rows) {
    if (emitted.has(row.id)) continue;
    const membership = info.get(row.id);
    if (!membership) {
      out.push(row);
      continue;
    }
    const siblings = rows
      .filter((r) => info.get(r.id)?.groupId === membership.groupId)
      .sort((a, b) => (info.get(a.id)?.memberIndex ?? 0) - (info.get(b.id)?.memberIndex ?? 0));
    for (const sibling of siblings) {
      out.push(sibling);
      emitted.add(sibling.id);
    }
  }
  return out;
}

export type LedgerFilter = {
  /** Ids shown in the "Live now" strip — never listed twice. */
  liveConvoIds?: ReadonlySet<string>;
  source: RunSourceFilter;
  project: ProjectFilter;
  workspaceRoot: string | null;
  query?: string;
};

export function filterLedgerEntries(
  entries: RunLedgerEntry[],
  filter: LedgerFilter,
): RunLedgerEntry[] {
  return entries.filter(
    (entry) =>
      !filter.liveConvoIds?.has(entry.id) &&
      sourceMatchesFilter(entry, filter.source) &&
      projectMatchesFilter(entry, filter.project, filter.workspaceRoot) &&
      runMatchesLedgerQuery(entry, filter.query ?? "")
  );
}

/**
 * Split into board sections, newest first.
 *
 * The id tiebreak is load-bearing: without it row order followed the
 * `[tasks, convos, runs]` concatenation, so paging in older runs — or swapping a
 * live convo for its on-disk twin — reshuffled rows already on screen.
 */
export function groupLedgerBySection(
  entries: RunLedgerEntry[],
  raceInfo: Map<string, RaceRowInfo> = new Map(),
): Record<RunBoardSection, RunLedgerEntry[]> {
  const by: Record<RunBoardSection, RunLedgerEntry[]> = {
    running: [],
    blocked: [],
    ready_for_review: [],
    done: [],
  };
  for (const entry of entries) by[boardSectionForRun(entry)].push(entry);
  for (const section of Object.keys(by) as RunBoardSection[]) {
    by[section].sort(
      (a, b) => b.updatedMs - a.updatedMs || (a.id < b.id ? 1 : a.id > b.id ? -1 : 0)
    );
    by[section] = clusterRaceRows(by[section], raceInfo);
  }
  return by;
}

export type LedgerChildIndex = {
  childrenOf(parentId: string): RunLedgerEntry[];
  hasChildren(parentId: string): boolean;
  /** Rows to render at the top level of a section: a child whose parent is
   *  visible renders nested under it instead. */
  topLevel(rows: RunLedgerEntry[]): RunLedgerEntry[];
};

/**
 * Index subagent rows under their parents.
 *
 * `all` is every ledger entry, not the filtered set, so a child still knows its
 * parent exists when the filter hides the parent (subagent-only view). `visible`
 * is what the filter kept — a child whose parent is filtered out has to render
 * flat, or it vanishes entirely.
 */
export function buildChildIndex(
  all: RunLedgerEntry[],
  visible: RunLedgerEntry[],
): LedgerChildIndex {
  const children = new Map<string, RunLedgerEntry[]>();
  for (const entry of all) {
    if (!entry.parentId) continue;
    const kids = children.get(entry.parentId) ?? [];
    kids.push(entry);
    children.set(entry.parentId, kids);
  }
  // Children read oldest-first: they are steps the parent took, in order.
  for (const kids of children.values()) kids.sort((a, b) => a.createdMs - b.createdMs);
  const visibleIds = new Set(visible.map((entry) => entry.id));
  return {
    childrenOf: (parentId) => children.get(parentId) ?? [],
    hasChildren: (parentId) => (children.get(parentId)?.length ?? 0) > 0,
    topLevel: (rows) => rows.filter((r) => !r.parentId || !visibleIds.has(r.parentId)),
  };
}

// missionBoard — the one projection from durable MissionState + the console's
// live run overlay into the rows the tier board AND the dependency graph
// render. Status arbitration, readiness, and block reasons are each decided
// here exactly once, so Board and Graph can never disagree about the same Task
// in the same render, and "n of m ready" moves when an acceptance lands.
//
// ADR-0002: this is projection only. It never decides which task runs next —
// Rust owns selection and dispatch; these rows are what the operator sees.
import {
  missionTaskReady,
  readyMissionTaskIds,
  type MissionState,
  type MissionTask,
  type MissionTaskAttempt,
  type MissionTaskStatus,
} from "./missionHarness";

/** What the console's run observer knows about a run it is streaming. */
export type LiveCardStatus = "idle" | "running" | "review" | "done" | "error" | "interrupted";
export type LiveCard = { status: LiveCardStatus; activity: string };

/** The authored plan row the board lays out. Ids match the durable task ids;
 *  the durable store may lag the plan (e.g. persistence failed), so the plan
 *  is the row source and durable state enriches it. */
export type BoardPlanTask = { taskId: string; title: string; dependsOn?: string[] };

export type MissionTaskRowBlock = {
  /** e.g. "blocked · Map modules failed" / "queued · after Draft the plan". */
  reason: string;
  tone: "danger" | "warning" | "quiet";
};

export type MissionTaskRow = {
  taskId: string;
  /** One vocabulary: MissionTaskStatus, with the live overlay arbitrated in. */
  status: MissionTaskStatus;
  /** Dispatchable now (approved mission) or on approval (draft preview). */
  ready: boolean;
  /** The dependency line the card renders; null for dependency-free tasks. */
  block: MissionTaskRowBlock | null;
  /** Latest durable attempt — what the review modal needs (runId, exit, signal). */
  lastAttempt: MissionTaskAttempt | null;
  /** Live streaming overlay for the activity line, when a run is attached. */
  live: LiveCard | null;
};

export type MissionBoardInput = {
  /** Compiled durable projection; null while the plan exists only in React. */
  state: MissionState | null;
  missionId: string | null;
  /** The plan in board order. */
  plan: BoardPlanTask[];
  /** Live run overlay keyed by task id. */
  liveCards: Record<string, LiveCard>;
  /** True while the Rust supervisor is driving the mission. */
  missionLive: boolean;
};

/**
 * The one arbitration between the durable event log and the live overlay.
 * Settled durable evidence (acceptance, review, rejection, interruption)
 * outranks the stream; while an attempt is merely running — or before any
 * attempt lands — the live overlay wins because durable events lag it.
 */
export function arbitrateMissionTaskStatus(
  durable: MissionTask | undefined,
  live: LiveCard | undefined
): MissionTaskStatus {
  if (durable?.acceptedRunId) return "done";
  const lastAttempt = durable?.attempts[durable.attempts.length - 1];
  if (lastAttempt) {
    if (lastAttempt.status === "review") return "review";
    if (lastAttempt.status === "interrupted") return "interrupted";
    if (lastAttempt.status === "dispatch-failed" || lastAttempt.status === "rejected") return "failed";
    // The attempt is still running as far as the log knows — the stream may
    // already have seen it finish or fail.
    return live ? liveTaskStatus(live.status) : "running";
  }
  if (live && live.status !== "idle") return liveTaskStatus(live.status);
  return durable?.status ?? "queued";
}

function liveTaskStatus(status: LiveCardStatus): MissionTaskStatus {
  if (status === "idle") return "queued";
  if (status === "error") return "failed";
  return status; // running | review | done | interrupted share the vocabulary
}

export function presentMissionBoard({ state, missionId, plan, liveCards, missionLive }: MissionBoardInput): MissionTaskRow[] {
  const mission = state && missionId ? state.missions[missionId] ?? null : null;
  const tasksById = state?.tasks ?? {};
  const approvedReady = mission && mission.approvedAtMs != null && state
    ? new Set(readyMissionTaskIds(state, mission.id))
    : null;
  const titleById: Record<string, string> = {};
  for (const task of plan) titleById[task.taskId] = task.title;

  const statusById: Record<string, MissionTaskStatus> = {};
  for (const task of plan) {
    statusById[task.taskId] = arbitrateMissionTaskStatus(tasksById[task.taskId], liveCards[task.taskId]);
  }

  return plan.map((planTask) => {
    const durable = tasksById[planTask.taskId] as MissionTask | undefined;
    const live = liveCards[planTask.taskId] ?? null;
    const ready = approvedReady
      ? approvedReady.has(planTask.taskId)
      : durable
        ? missionTaskReady(durable, tasksById)
        : (planTask.dependsOn ?? []).length === 0;
    return {
      taskId: planTask.taskId,
      status: statusById[planTask.taskId],
      ready,
      block: blockFor(planTask, statusById, titleById, tasksById, live, missionLive),
      lastAttempt: durable?.attempts[durable.attempts.length - 1] ?? null,
      live,
    };
  });
}

// Mission-aware dependency line: a parked upstream failure blocks; an
// interrupted upstream parks for retry (amber, not a failure); waiting its
// turn in a live mission reads queued. Upstream state is the arbitrated
// status, so the reason a card gives always matches what the upstream card
// itself shows.
function blockFor(
  planTask: BoardPlanTask,
  statusById: Record<string, MissionTaskStatus>,
  titleById: Record<string, string>,
  tasksById: Record<string, MissionTask>,
  live: LiveCard | null,
  missionLive: boolean
): MissionTaskRowBlock | null {
  const deps = planTask.dependsOn ?? [];
  if (deps.length === 0) return null;
  const title = (id: string) => (titleById[id] ?? tasksById[id]?.title ?? id).slice(0, 24);
  const failed = deps.find((id) => statusById[id] === "failed");
  if (failed) return { reason: `blocked · ${title(failed)} failed`, tone: "danger" };
  const interrupted = deps.find((id) => statusById[id] === "interrupted");
  if (interrupted) return { reason: `blocked · ${title(interrupted)} interrupted`, tone: "warning" };
  const first = deps[0];
  if (missionLive && !live) return { reason: `queued · after ${title(first)}`, tone: "quiet" };
  return { reason: `after ${title(first)}`, tone: "quiet" };
}

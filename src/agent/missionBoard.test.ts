import { describe, expect, it } from "vitest";
import {
  createMission,
  createMissionTask,
  EMPTY_MISSION_STATE,
  missionReducer,
  type MissionAttemptValidation,
  type MissionState,
} from "./missionHarness";
import {
  arbitrateMissionTaskStatus,
  presentMissionBoard,
  type BoardPlanTask,
  type LiveCard,
  type MissionBoardInput,
} from "./missionBoard";

// `presentMissionBoard` is the one projection both the tier board and the
// dependency graph render. Before it existed the console re-derived readiness
// from the planner's static `dependsOn` (so "n of m ready" froze after the
// plan), arbitrated durable-vs-live status in a JSX ternary with its own
// 6-value vocabulary, and hand-walked dependency statuses for block reasons —
// and fed the graph raw durable status without the live overlay, so Board and
// Graph could disagree about the same Task in the same render.

const MISSION = "mission-1";
const T = 1_000;

const PLAN: BoardPlanTask[] = [
  { taskId: "inspect", title: "inspect" },
  { taskId: "implement", title: "implement", dependsOn: ["inspect"] },
];

function validation(overrides: Partial<MissionAttemptValidation> = {}): MissionAttemptValidation {
  return {
    status: "passed",
    checks: [],
    filesChanged: 1,
    commandsRun: 1,
    commandsFailed: 0,
    diffReviews: 1,
    permissionsApproved: 0,
    permissionsDenied: 0,
    warnings: [],
    ...overrides,
  };
}

/** A mission with `inspect` and `implement`, the latter depending on the former. */
function twoTaskMission(opts: { approved?: boolean } = {}): MissionState {
  let state = missionReducer(EMPTY_MISSION_STATE, {
    type: "mission_created",
    mission: createMission({ id: MISSION, title: "Ship it", intent: "…", mode: "goal", nowMs: T }),
  });
  for (const planTask of PLAN) {
    state = missionReducer(state, {
      type: "task_added",
      task: createMissionTask({
        missionId: MISSION,
        id: planTask.taskId,
        title: planTask.title,
        dependencies: planTask.dependsOn ?? [],
        nowMs: T,
      }),
    });
  }
  if (opts.approved !== false) {
    state = missionReducer(state, { type: "mission_plan_approved", missionId: MISSION, ts: T });
  }
  return state;
}

function acceptTask(state: MissionState, taskId: string, runId: string): MissionState {
  let next = missionReducer(state, { type: "task_run_attached", taskId, runId, ts: T + 1 });
  next = missionReducer(next, { type: "task_attempt_settled", taskId, runId, exitCode: 0, ts: T + 2 });
  return missionReducer(next, {
    type: "task_attempt_validated",
    taskId,
    runId,
    accepted: true,
    validation: validation(),
    ts: T + 3,
  });
}

function board(overrides: Partial<MissionBoardInput> = {}) {
  return presentMissionBoard({
    state: twoTaskMission(),
    missionId: MISSION,
    plan: PLAN,
    liveCards: {},
    missionLive: false,
    ...overrides,
  });
}

const row = (rows: ReturnType<typeof presentMissionBoard>, taskId: string) => {
  const found = rows.find((candidate) => candidate.taskId === taskId);
  if (!found) throw new Error(`no row ${taskId}`);
  return found;
};

const running: LiveCard = { status: "running", activity: "reading files…" };

describe("readiness follows acceptance (the frozen-count bug)", () => {
  it("marks only the dependency-free task ready after approval", () => {
    const rows = board();
    expect(row(rows, "inspect").ready).toBe(true);
    expect(row(rows, "implement").ready).toBe(false);
  });

  it("moves readiness downstream when an acceptance lands", () => {
    // The deleted `dependsOn.length === 0` filter could never produce this:
    // `implement` has a dependency forever, so its ready flag never flipped.
    const rows = board({ state: acceptTask(twoTaskMission(), "inspect", "run-1") });
    expect(row(rows, "inspect").ready).toBe(false); // done, not re-dispatchable
    expect(row(rows, "implement").ready).toBe(true);
    expect(rows.filter((r) => r.ready)).toHaveLength(1);
  });

  it("previews dependency-free readiness before approval, so Run Mission stays reachable", () => {
    const rows = board({ state: twoTaskMission({ approved: false }) });
    expect(row(rows, "inspect").ready).toBe(true);
    expect(row(rows, "implement").ready).toBe(false);
  });

  it("previews from the plan alone while the mission is not yet durable", () => {
    const rows = board({ state: null, missionId: null });
    expect(row(rows, "inspect").ready).toBe(true);
    expect(row(rows, "implement").ready).toBe(false);
  });
});

describe("status arbitration precedence", () => {
  it("durable acceptance beats a stale live card", () => {
    const state = acceptTask(twoTaskMission(), "inspect", "run-1");
    expect(arbitrateMissionTaskStatus(state.tasks["inspect"], running)).toBe("done");
  });

  it("a settled attempt awaiting review beats a stale live card", () => {
    let state = missionReducer(twoTaskMission(), { type: "task_run_attached", taskId: "inspect", runId: "run-1", ts: T + 1 });
    state = missionReducer(state, { type: "task_attempt_settled", taskId: "inspect", runId: "run-1", exitCode: 0, ts: T + 2 });
    expect(arbitrateMissionTaskStatus(state.tasks["inspect"], running)).toBe("review");
  });

  it("a rejected attempt reads failed even while a live card lingers", () => {
    let state = missionReducer(twoTaskMission(), { type: "task_run_attached", taskId: "inspect", runId: "run-1", ts: T + 1 });
    state = missionReducer(state, {
      type: "task_attempt_validated",
      taskId: "inspect",
      runId: "run-1",
      accepted: false,
      validation: validation({ status: "failed" }),
      ts: T + 2,
    });
    expect(arbitrateMissionTaskStatus(state.tasks["inspect"], running)).toBe("failed");
  });

  it("an interrupted attempt beats a stale live card", () => {
    let state = missionReducer(twoTaskMission(), { type: "task_run_attached", taskId: "inspect", runId: "run-1", ts: T + 1 });
    state = missionReducer(state, { type: "task_attempt_interrupted", taskId: "inspect", runId: "run-1", reason: "restart", ts: T + 2 });
    expect(arbitrateMissionTaskStatus(state.tasks["inspect"], running)).toBe("interrupted");
  });

  it("the live stream beats a durable attempt the log still thinks is running", () => {
    const state = missionReducer(twoTaskMission(), { type: "task_run_attached", taskId: "inspect", runId: "run-1", ts: T + 1 });
    expect(arbitrateMissionTaskStatus(state.tasks["inspect"], { status: "done", activity: "done" })).toBe("done");
    expect(arbitrateMissionTaskStatus(state.tasks["inspect"], { status: "error", activity: "boom" })).toBe("failed");
    expect(arbitrateMissionTaskStatus(state.tasks["inspect"], undefined)).toBe("running");
  });

  it("a live run beats the durable queue position before any attempt lands", () => {
    const state = twoTaskMission();
    expect(state.tasks["inspect"].status).toBe("ready");
    expect(arbitrateMissionTaskStatus(state.tasks["inspect"], running)).toBe("running");
  });

  it("falls through to the durable status, then queued, when nothing is live", () => {
    const state = twoTaskMission();
    expect(arbitrateMissionTaskStatus(state.tasks["implement"], undefined)).toBe("blocked");
    expect(arbitrateMissionTaskStatus(undefined, undefined)).toBe("queued");
  });
});

describe("block reasons", () => {
  function withInspectAttempt(finish: "rejected" | "interrupted"): MissionState {
    let state = missionReducer(twoTaskMission(), { type: "task_run_attached", taskId: "inspect", runId: "run-1", ts: T + 1 });
    if (finish === "interrupted") {
      return missionReducer(state, { type: "task_attempt_interrupted", taskId: "inspect", runId: "run-1", reason: "restart", ts: T + 2 });
    }
    state = missionReducer(state, { type: "task_attempt_settled", taskId: "inspect", runId: "run-1", exitCode: 1, ts: T + 2 });
    return missionReducer(state, {
      type: "task_attempt_validated",
      taskId: "inspect",
      runId: "run-1",
      accepted: false,
      validation: validation({ status: "failed" }),
      ts: T + 3,
    });
  }

  it("is null for dependency-free tasks", () => {
    expect(row(board(), "inspect").block).toBeNull();
  });

  it("names a plain follow order while nothing is live", () => {
    expect(row(board(), "implement").block).toEqual({ reason: "after inspect", tone: "quiet" });
  });

  it("reads queued while the mission is live and the task has no run yet", () => {
    const rows = board({ missionLive: true });
    expect(row(rows, "implement").block).toEqual({ reason: "queued · after inspect", tone: "quiet" });
  });

  it("blocks on a failed upstream with a danger tone", () => {
    const rows = board({ state: withInspectAttempt("rejected") });
    expect(row(rows, "implement").block).toEqual({ reason: "blocked · inspect failed", tone: "danger" });
  });

  it("blocks on an interrupted upstream with a warning tone, not a failure", () => {
    const rows = board({ state: withInspectAttempt("interrupted") });
    expect(row(rows, "implement").block).toEqual({ reason: "blocked · inspect interrupted", tone: "warning" });
  });

  it("names the dependency that actually failed, not just the first one", () => {
    let state = missionReducer(withInspectAttempt("rejected"), {
      type: "task_added",
      task: createMissionTask({ missionId: MISSION, id: "review", title: "review", dependencies: ["implement", "inspect"], nowMs: T }),
    });
    const plan: BoardPlanTask[] = [
      ...PLAN,
      { taskId: "review", title: "review", dependsOn: ["implement", "inspect"] },
    ];
    const rows = board({ state, plan });
    expect(row(rows, "review").block).toEqual({ reason: "blocked · inspect failed", tone: "danger" });
  });

  it("truncates long dependency titles to 24 characters", () => {
    const longTitle = "a dependency title far too long for one card line";
    const plan: BoardPlanTask[] = [
      { taskId: "inspect", title: longTitle },
      { taskId: "implement", title: "implement", dependsOn: ["inspect"] },
    ];
    const rows = board({ state: null, missionId: null, plan });
    expect(row(rows, "implement").block?.reason).toBe(`after ${longTitle.slice(0, 24)}`);
  });
});

describe("board and graph consistency", () => {
  it("projects one status per task, live overlay included, for both views", () => {
    // The old console fed the graph `durableState.tasks[id].status` ("ready")
    // while the board's ternary showed the live overlay ("working") — the same
    // Task in two states in one render. Both now read this single row.
    const rows = board({ liveCards: { inspect: running } });
    expect(row(rows, "inspect").status).toBe("running");
    expect(row(rows, "inspect").live).toEqual(running);
  });

  it("carries the attempt the review modal needs", () => {
    let state = missionReducer(twoTaskMission(), { type: "task_run_attached", taskId: "inspect", runId: "run-1", ts: T + 1 });
    state = missionReducer(state, { type: "task_attempt_settled", taskId: "inspect", runId: "run-1", exitCode: 2, signal: undefined, ts: T + 2 });
    const rows = board({ state });
    expect(row(rows, "inspect").status).toBe("review");
    expect(row(rows, "inspect").lastAttempt).toMatchObject({ runId: "run-1", status: "review", exitCode: 2 });
    expect(row(rows, "implement").lastAttempt).toBeNull();
  });
});

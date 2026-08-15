import { describe, it, expect } from "vitest";
import {
  chooseAssignment,
  DEFAULT_ROUTING_POLICY,
  routeTask,
  type RoutingPolicy,
  type RouteTaskInput,
} from "./routingPolicy";
import { budgetReducer, createBudgetLedger, type BudgetLedger } from "./budgetLedger";
import { createCapacityState, type CapacityState } from "./capacityPlanner";

// A low-risk, read-only plan task routes to the "local" tier (see
// chooseModelTier's final fallthrough), so we can assert the local tier's
// advisor without pinning the exact tier heuristics.
const LOCAL_TASK: RouteTaskInput = {
  taskId: "t1",
  title: "tidy a comment",
  mode: "plan",
  risk: "low",
  writesFiles: false,
};

describe("per-tier advisor plumbing", () => {
  it("defaults the assignment advisor to null so the run uses the global advisor", () => {
    const a = chooseAssignment({ ...LOCAL_TASK });
    expect(a.modelTier).toBe("local");
    expect(a.advisor).toBeNull();
  });

  it("carries the tier's advisor from policy.advisorByTier onto the assignment", () => {
    const policy: RoutingPolicy = {
      ...DEFAULT_ROUTING_POLICY,
      advisorByTier: {
        ...DEFAULT_ROUTING_POLICY.advisorByTier!,
        local: { provider: "anthropic", model: "claude-opus-4-8" },
      },
    };
    const a = chooseAssignment({ ...LOCAL_TASK }, policy);
    expect(a.advisor).toEqual({ provider: "anthropic", model: "claude-opus-4-8" });
  });
});

// `routeTask` is the gate v0.6 dispatch will stand behind: budget first, then
// capacity, and only then an admission. The denial branches are what keep a
// mission's spend and parallelism inside their envelopes, so each one gets a
// row here — the reason string is part of the contract (it's what the operator
// reads on the parked task), as is the `suggestedAssignment` that lets the
// console offer "approve anyway" without re-routing.

/** A goal-mode write task, so capacity needs a worktree-writer slot. */
const WRITE_TASK: RouteTaskInput = {
  taskId: "t2",
  title: "implement the fix",
  mode: "goal",
  risk: "medium",
  writesFiles: true,
};

const openBudget = () => createBudgetLedger({ missionId: "m1", preset: "maximum", nowMs: 0 });

describe("routeTask budget denials", () => {
  const cases: Array<{
    name: string;
    task: RouteTaskInput;
    ledger: () => BudgetLedger;
    reason: string;
  }> = [
    {
      name: "estimated cost exceeds the remaining envelope",
      task: { ...WRITE_TASK, estimatedCostUsd: 2, estimatedDurationMs: 60_000 },
      ledger: () => createBudgetLedger({ missionId: "m1", preset: "lean", nowMs: 0 }),
      reason: "Estimated cost exceeds the approved budget.",
    },
    {
      name: "estimated duration exceeds the remaining time envelope",
      task: { ...WRITE_TASK, estimatedCostUsd: 0, estimatedDurationMs: 21 * 60_000 },
      ledger: () => createBudgetLedger({ missionId: "m1", preset: "lean", nowMs: 0 }),
      reason: "Estimated duration exceeds the approved time budget.",
    },
    {
      name: "a retry after the retry budget is exhausted",
      task: { ...WRITE_TASK, estimatedCostUsd: 0, estimatedDurationMs: 0, retry: true },
      ledger: () =>
        budgetReducer(createBudgetLedger({ missionId: "m1", preset: "lean", nowMs: 0 }), {
          type: "retry_recorded",
          taskId: WRITE_TASK.taskId,
          ts: 1,
        }),
      reason: "Retry budget is exhausted.",
    },
    {
      name: "an escalation under an ask-before-escalation envelope",
      task: { ...WRITE_TASK, estimatedCostUsd: 0, estimatedDurationMs: 0, escalation: true },
      ledger: () => createBudgetLedger({ missionId: "m1", preset: "lean", nowMs: 0 }),
      reason: "Escalation requires approval for this budget preset.",
    },
  ];

  it.each(cases)("denies $name", ({ task, ledger, reason }) => {
    const decision = routeTask({ task, budget: ledger(), capacity: createCapacityState({ nowMs: 0 }) });
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    expect(decision.reason).toBe(reason);
    expect(decision.budget.ok).toBe(false);
    expect(decision.budget.status).toBe("needs-approval");
    // Budget is checked before capacity: a denied budget never reserves slots.
    expect(decision.capacity).toBeUndefined();
    // The routing itself still happened — the console can show what would run.
    expect(decision.suggestedAssignment?.taskId).toBe(task.taskId);
  });
});

describe("routeTask capacity denials", () => {
  const cases: Array<{
    name: string;
    task: RouteTaskInput;
    capacity: () => CapacityState;
    blockedBy: string;
  }> = [
    {
      name: "a write task while another worker holds the worktree",
      task: { ...WRITE_TASK, estimatedCostUsd: 0, estimatedDurationMs: 0 },
      capacity: () => createCapacityState({ slots: { "worktree-writer": { used: 1 } }, nowMs: 0 }),
      blockedBy: "worktree-writer",
    },
    {
      name: "a local task while the local model slot is busy",
      task: { ...LOCAL_TASK, estimatedCostUsd: 0, estimatedDurationMs: 0 },
      capacity: () => createCapacityState({ slots: { "local-model": { used: 1 } }, nowMs: 0 }),
      blockedBy: "local-model",
    },
  ];

  it.each(cases)("defers $name", ({ task, capacity, blockedBy }) => {
    const decision = routeTask({ task, budget: openBudget(), capacity: capacity() });
    expect(decision.ok).toBe(false);
    if (decision.ok) return;
    // The budget said yes — the denial is capacity's alone, and both decisions
    // travel with the result so the console can say which gate closed.
    expect(decision.budget.ok).toBe(true);
    expect(decision.capacity).toEqual(
      expect.objectContaining({ ok: false, blockedBy })
    );
    expect(decision.reason).toContain("full");
    expect(decision.suggestedAssignment?.taskId).toBe(task.taskId);
  });

  it("admits the task when budget and capacity both allow", () => {
    const decision = routeTask({
      task: { ...WRITE_TASK, estimatedCostUsd: 0, estimatedDurationMs: 0 },
      budget: openBudget(),
      capacity: createCapacityState({ nowMs: 0 }),
    });
    expect(decision.ok).toBe(true);
    if (!decision.ok) return;
    expect(decision.capacity.ok).toBe(true);
    expect(decision.assignment.capacityNeed.kinds).toContain("worktree-writer");
  });
});

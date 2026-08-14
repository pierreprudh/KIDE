export type ValidationCheckKind =
  | "typecheck"
  | "test"
  | "lint"
  | "format"
  | "diff-scope"
  | "semantic-review"
  | "visual"
  | "human"
  | "budget";

export type ValidationReviewer = "klide" | "orchestrator" | "delegate" | "user";

export type ValidationCheckStatus = "pending" | "running" | "passed" | "failed" | "waived" | "skipped";

export type ValidationCheck = {
  id: string;
  kind: ValidationCheckKind;
  label: string;
  required: boolean;
  status: ValidationCheckStatus;
  command?: string;
  reviewer?: ValidationReviewer;
  message?: string;
  updatedMs: number;
};

export type ValidationContractStatus = "pending" | "running" | "passed" | "failed" | "waived";

export type ValidationContract = {
  id: string;
  taskId: string;
  checks: ValidationCheck[];
  status: ValidationContractStatus;
  createdMs: number;
  updatedMs: number;
};

export type ValidationState = {
  contracts: Record<string, ValidationContract>;
};

export type ValidationAction =
  | { type: "contract_created"; contract: ValidationContract }
  | {
      type: "check_status_changed";
      contractId: string;
      checkId: string;
      status: ValidationCheckStatus;
      message?: string;
      ts: number;
    }
  | { type: "contract_waived"; contractId: string; message?: string; ts: number };

export type ValidationSummary = {
  total: number;
  required: number;
  passed: number;
  failed: number;
  running: number;
  pending: number;
  waived: number;
  blockingFailures: ValidationCheck[];
};

export const EMPTY_VALIDATION_STATE: ValidationState = {
  contracts: {},
};

export function createValidationCheck(
  input: Omit<ValidationCheck, "id" | "status" | "updatedMs"> & {
    id?: string;
    status?: ValidationCheckStatus;
    updatedMs?: number;
  }
): ValidationCheck {
  return {
    id: input.id ?? makeId("check"),
    kind: input.kind,
    label: input.label,
    required: input.required,
    status: input.status ?? "pending",
    command: input.command,
    reviewer: input.reviewer,
    message: input.message,
    updatedMs: input.updatedMs ?? Date.now(),
  };
}

export function createValidationContract(input: {
  id?: string;
  taskId: string;
  checks: ValidationCheck[];
  createdMs?: number;
  updatedMs?: number;
}): ValidationContract {
  const now = Date.now();
  const updatedMs = input.updatedMs ?? input.createdMs ?? now;
  const contract: ValidationContract = {
    id: input.id ?? makeId("validation"),
    taskId: input.taskId,
    checks: input.checks,
    status: "pending",
    createdMs: input.createdMs ?? now,
    updatedMs,
  };
  return { ...contract, status: deriveValidationStatus(contract.checks) };
}

export function validationReducer(
  state: ValidationState = EMPTY_VALIDATION_STATE,
  action: ValidationAction
): ValidationState {
  if (action.type === "contract_created") {
    return {
      contracts: {
        ...state.contracts,
        [action.contract.id]: action.contract,
      },
    };
  }

  const contract =
    action.type === "check_status_changed" || action.type === "contract_waived"
      ? state.contracts[action.contractId]
      : undefined;
  if (!contract) return state;

  if (action.type === "contract_waived") {
    return {
      contracts: {
        ...state.contracts,
        [contract.id]: {
          ...contract,
          checks: contract.checks.map((check) =>
            check.status === "passed"
              ? check
              : { ...check, status: "waived", message: action.message ?? check.message, updatedMs: action.ts }
          ),
          status: "waived",
          updatedMs: action.ts,
        },
      },
    };
  }

  const checks = contract.checks.map((check) =>
    check.id === action.checkId
      ? {
          ...check,
          status: action.status,
          message: action.message ?? check.message,
          updatedMs: action.ts,
        }
      : check
  );

  return {
    contracts: {
      ...state.contracts,
      [contract.id]: {
        ...contract,
        checks,
        status: deriveValidationStatus(checks),
        updatedMs: action.ts,
      },
    },
  };
}

export function deriveValidationStatus(checks: ValidationCheck[]): ValidationContractStatus {
  if (checks.some((check) => check.required && check.status === "failed")) return "failed";
  if (checks.some((check) => check.status === "running")) return "running";
  if (checks.length > 0 && checks.every((check) => check.status === "waived" || check.status === "skipped")) {
    return "waived";
  }
  if (checks.length > 0 && checks.every((check) => check.status === "passed" || check.status === "waived" || check.status === "skipped")) {
    return "passed";
  }
  return "pending";
}

export function summarizeValidation(contract: ValidationContract | null | undefined): ValidationSummary {
  const checks = contract?.checks ?? [];
  const blockingFailures = checks.filter((check) => check.required && check.status === "failed");
  return {
    total: checks.length,
    required: checks.filter((check) => check.required).length,
    passed: checks.filter((check) => check.status === "passed").length,
    failed: checks.filter((check) => check.status === "failed").length,
    running: checks.filter((check) => check.status === "running").length,
    pending: checks.filter((check) => check.status === "pending").length,
    waived: checks.filter((check) => check.status === "waived").length,
    blockingFailures,
  };
}

export function defaultValidationChecks(input: {
  taskId: string;
  risk: "low" | "medium" | "high";
  writesFiles: boolean;
  needsVisualReview?: boolean;
  nowMs?: number;
}): ValidationCheck[] {
  const nowMs = input.nowMs ?? Date.now();
  const checks: ValidationCheck[] = [
    createValidationCheck({
      id: `${input.taskId}:budget`,
      kind: "budget",
      label: "Budget stayed inside approved limits",
      required: true,
      updatedMs: nowMs,
    }),
  ];

  if (input.writesFiles) {
    checks.push(
      createValidationCheck({
        id: `${input.taskId}:diff-scope`,
        kind: "diff-scope",
        label: "Changed files match task scope",
        required: true,
        reviewer: "klide",
        updatedMs: nowMs,
      }),
      createValidationCheck({
        id: `${input.taskId}:typecheck`,
        kind: "typecheck",
        label: "Typecheck passes",
        required: input.risk !== "low",
        command: "npm run build",
        updatedMs: nowMs,
      })
    );
  }

  if (input.risk === "high") {
    checks.push(
      createValidationCheck({
        id: `${input.taskId}:semantic-review`,
        kind: "semantic-review",
        label: "Strong model reviews output against intent",
        required: true,
        reviewer: "orchestrator",
        updatedMs: nowMs,
      }),
      createValidationCheck({
        id: `${input.taskId}:human`,
        kind: "human",
        label: "User approves final result",
        required: true,
        reviewer: "user",
        updatedMs: nowMs,
      })
    );
  }

  if (input.needsVisualReview) {
    checks.push(
      createValidationCheck({
        id: `${input.taskId}:visual`,
        kind: "visual",
        label: "Visual smoke review passes",
        required: input.risk !== "low",
        reviewer: "klide",
        updatedMs: nowMs,
      })
    );
  }

  return checks;
}

function makeId(prefix: string): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return `${prefix}:${crypto.randomUUID()}`;
  return `${prefix}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2)}`;
}

// ── The wire ────────────────────────────────────────────────────────────────
//
// Everything above is the *authored* side of the Validation contract — the
// checks a routing decision plans for a task before it runs. What comes back
// from a settled Run is the Rust Harness's evidence snapshot
// (`AgentValidationSummary` in `src-tauri/src/agent/types.rs`), and it crosses
// the IPC boundary twice: on `AgentRunSummary.validation` for the run board,
// and inside the durable Mission log's `attempt_validation_recorded` event.
// Both crossings parse here, so the words Rust writes are a union — not a
// `string` — everywhere downstream, and a new word on the wire is a tsc error
// instead of a silently colour-less row.

/**
 * The status words the Rust producers actually write — `summarize_validation`
 * in `agent/transcripts.rs` and `delegate_review_validation` in `missions.rs`.
 * Summary statuses use all four; check statuses use the first three.
 * `validationWire.test.ts` reads those two functions and fails when this list
 * drifts from the Rust source.
 */
export const VALIDATION_WIRE_STATUSES = ["passed", "failed", "skipped", "unverified"] as const;

export type ValidationWireStatus = (typeof VALIDATION_WIRE_STATUSES)[number];

/**
 * A Mission log and a Transcript summary are durable history: a snapshot
 * written by a newer (or older) Klide may carry a word this build doesn't
 * know. The parser maps it to `"unknown"` rather than throwing, so old logs
 * still render — quietly, without asserting a verdict.
 */
export type ValidationStatus = ValidationWireStatus | "unknown";

export type RecordedValidationCheck = {
  id: string;
  label: string;
  status: ValidationStatus;
  required: boolean;
  evidence?: string;
};

/**
 * The parsed evidence snapshot for one settled Run — the Validation contract
 * as recorded, not as planned. `runs.ts` aliases this as
 * `RunValidationSummary` and `missionHarness.ts` as `MissionAttemptValidation`;
 * the shape has one owner.
 */
export type RecordedValidation = {
  status: ValidationStatus;
  checks: RecordedValidationCheck[];
  filesChanged: number;
  commandsRun: number;
  commandsFailed: number;
  diffReviews: number;
  permissionsApproved: number;
  permissionsDenied: number;
  warnings: string[];
};

export function parseValidationStatus(raw: unknown): ValidationStatus {
  return typeof raw === "string" && (VALIDATION_WIRE_STATUSES as readonly string[]).includes(raw)
    ? (raw as ValidationWireStatus)
    : "unknown";
}

/**
 * The parser at the IPC edge: raw wire value in, typed snapshot out. Tolerant
 * on purpose — unknown statuses become `"unknown"`, missing counts become 0,
 * malformed checks keep their position — because the input is durable history
 * that must still render, never a reason to crash a board.
 */
export function parseValidationSummary(raw: unknown): RecordedValidation {
  const source = isRecord(raw) ? raw : {};
  return {
    status: parseValidationStatus(source.status),
    checks: Array.isArray(source.checks) ? source.checks.map(parseValidationCheck) : [],
    filesChanged: toCount(source.filesChanged),
    commandsRun: toCount(source.commandsRun),
    commandsFailed: toCount(source.commandsFailed),
    diffReviews: toCount(source.diffReviews),
    permissionsApproved: toCount(source.permissionsApproved),
    permissionsDenied: toCount(source.permissionsDenied),
    warnings: Array.isArray(source.warnings)
      ? source.warnings.filter((warning): warning is string => typeof warning === "string")
      : [],
  };
}

function parseValidationCheck(raw: unknown, index: number): RecordedValidationCheck {
  const source = isRecord(raw) ? raw : {};
  return {
    id: typeof source.id === "string" ? source.id : `check-${index}`,
    label: typeof source.label === "string" ? source.label : "",
    status: parseValidationStatus(source.status),
    required: source.required === true,
    evidence: typeof source.evidence === "string" ? source.evidence : undefined,
  };
}

function toCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

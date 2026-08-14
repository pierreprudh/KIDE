import { describe, expect, it } from "vitest";
import { parseValidationStatus, parseValidationSummary, VALIDATION_WIRE_STATUSES } from "./validationContracts";
import transcriptsRs from "../../src-tauri/src/agent/transcripts.rs?raw";
import missionsRs from "../../src-tauri/src/missions.rs?raw";

// The Validation contract's wire vocabulary is typed by hand in two languages:
// Rust writes the status words (`summarize_validation` in
// `agent/transcripts.rs`, `delegate_review_validation` in `missions.rs`) and
// `VALIDATION_WIRE_STATUSES` mirrors them for every TypeScript consumer.
// Nothing else checks the pair: a word added in Rust and forgotten here would
// reach the operator as a quiet `"unknown"` — rendered, but colour-less — and
// a word removed from Rust would leave the mirror asserting statuses nothing
// emits. Same seam as Rust's `frontend_mirror_matches_agent_wire`, pointed the
// other way: this side reads the Rust source, so drift is a failing test on
// whichever half moved.

/** The body of `fn <name>`, by brace counting from its first `{`. */
function functionBody(source: string, name: string): string {
  const start = source.indexOf(`fn ${name}`);
  if (start === -1) throw new Error(`fn ${name} not found in Rust source`);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    if (source[i] === "{") depth += 1;
    else if (source[i] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(open, i + 1);
    }
  }
  throw new Error(`fn ${name} has unbalanced braces`);
}

/**
 * Every status word a producer body writes. A status is born in one of two
 * shapes — the struct field `status: <expr>.to_string(),` or the summary's
 * `let status = <expr>.to_string();` — so the literals inside those spans are
 * exactly the vocabulary, without picking up check ids, labels, or warnings.
 */
function emittedStatuses(body: string): Set<string> {
  const statuses = new Set<string>();
  for (const span of body.matchAll(/(?:\bstatus:\s*|\blet status = )([\s\S]*?)\.to_string\(\)/g)) {
    for (const literal of span[1].matchAll(/"([^"]*)"/g)) statuses.add(literal[1]);
  }
  return statuses;
}

const PRODUCERS = [
  { source: transcriptsRs, fn: "summarize_validation" },
  { source: missionsRs, fn: "delegate_review_validation" },
] as const;

describe("validation wire vocabulary", () => {
  it("matches the status words the Rust producers actually write", () => {
    const emitted = new Set<string>();
    for (const producer of PRODUCERS) {
      const statuses = emittedStatuses(functionBody(producer.source, producer.fn));
      // A producer with no extracted statuses means the extraction went stale,
      // not that Rust stopped emitting — fail loudly rather than vacuously.
      expect(statuses.size, producer.fn).toBeGreaterThan(0);
      for (const status of statuses) emitted.add(status);
    }
    expect([...emitted].sort()).toEqual([...VALIDATION_WIRE_STATUSES].sort());
  });
});

describe("parseValidationSummary", () => {
  it("passes a well-formed wire summary through unchanged", () => {
    const wire = {
      status: "passed",
      checks: [
        {
          id: "diff-review",
          label: "Changed files passed Diff review",
          status: "passed",
          required: true,
          evidence: "2 applied, 0 rejected",
        },
        {
          id: "command-validation",
          label: "No validation command needed for read-only run",
          status: "skipped",
          required: false,
        },
      ],
      filesChanged: 2,
      commandsRun: 1,
      commandsFailed: 0,
      diffReviews: 2,
      permissionsApproved: 1,
      permissionsDenied: 0,
      warnings: ["1 permission request(s) denied."],
    };
    expect(parseValidationSummary(wire)).toEqual(wire);
  });

  it("maps a status word this build doesn't know to explicit unknown", () => {
    expect(parseValidationStatus("half-passed")).toBe("unknown");
    const parsed = parseValidationSummary({
      status: "half-passed",
      checks: [{ id: "c", label: "l", status: "wavering", required: true }],
    });
    expect(parsed.status).toBe("unknown");
    expect(parsed.checks[0].status).toBe("unknown");
  });

  it("renders garbage as an empty snapshot instead of throwing", () => {
    // A Mission log is durable history — a torn or foreign line must still
    // produce something a board can draw.
    for (const garbage of [null, undefined, 42, "passed", [], { checks: "no" }]) {
      const parsed = parseValidationSummary(garbage);
      expect(parsed.status).toBe("unknown");
      expect(parsed.checks).toEqual([]);
      expect(parsed.filesChanged).toBe(0);
      expect(parsed.warnings).toEqual([]);
    }
  });

  it("keeps malformed checks in position with unknown status", () => {
    const parsed = parseValidationSummary({
      status: "failed",
      checks: [null, { id: "real", label: "Real check", status: "failed", required: true }],
    });
    expect(parsed.checks).toHaveLength(2);
    expect(parsed.checks[0]).toEqual({
      id: "check-0",
      label: "",
      status: "unknown",
      required: false,
      evidence: undefined,
    });
    expect(parsed.checks[1].id).toBe("real");
  });
});

import { describe, expect, it } from "vitest";
import {
  presentBoardSection,
  presentLifecycle,
  presentLiveDelegate,
  presentReasonTone,
  presentRunStatus,
  presentValidation,
  toneColor,
  type StateWord,
} from "./runPresentation";
import {
  BOARD_SECTION_LABEL,
  BOARD_SECTION_ORDER,
  LIFECYCLE_LABEL,
  LIFECYCLE_STATUSES,
  STATUS_COLOR,
  STATUS_LABEL,
  STATUS_ORDER,
} from "./runs";

describe("the one status vocabulary", () => {
  it("uses only the eight agreed words", () => {
    const allowed: StateWord[] = [
      "Working",
      "Waiting",
      "Blocked",
      "Done",
      "Queued",
      "Stopped",
      "Failed",
      "Idle",
    ];
    const words = [
      ...STATUS_ORDER.map((s) => presentRunStatus(s).word),
      ...LIFECYCLE_STATUSES.map((s) => presentLifecycle(s).word),
      ...BOARD_SECTION_ORDER.map(presentBoardSection),
      ...(["running", "working", "idle", "blocked", "waiting"] as const).map(
        (s) => presentLiveDelegate(s).word
      ),
    ];
    for (const word of words) expect(allowed).toContain(word);
  });

  it("gives every state a word and a tone", () => {
    // Exhaustive switches, so a new state is a type error rather than an
    // `undefined` rendered into the board.
    for (const s of STATUS_ORDER) {
      expect(presentRunStatus(s).word).toBeTruthy();
      expect(toneColor(presentRunStatus(s).tone)).toMatch(/^var\(--/);
    }
    for (const s of LIFECYCLE_STATUSES) {
      expect(presentLifecycle(s).word).toBeTruthy();
      expect(toneColor(presentLifecycle(s).tone)).toMatch(/^var\(--/);
    }
  });

  it("keeps a board row's waiting distinct from a live delegate's", () => {
    // The overlap that looks like a bug and is not. Both surfaces are correct
    // for their own vocabulary; see the note at the top of runPresentation.ts.
    // A run parked on a gate cannot proceed → Blocked.
    expect(presentRunStatus("waiting")).toEqual({ word: "Blocked", tone: "attention" });
    // A Delegate whose turn finished is idle at its composer, output on you →
    // Waiting.
    expect(presentLiveDelegate("waiting")).toEqual({ word: "Waiting", tone: "ready" });
    // Which means they must not share a colour either.
    expect(toneColor("attention")).not.toEqual(toneColor("ready"));
  });

  it("separates blocked-on-you from ready-to-read in the lifecycle", () => {
    expect(presentLifecycle("waiting").word).toBe("Blocked");
    expect(presentLifecycle("needs_review").word).toBe("Waiting");
  });

  it("names a section the same word as the rows inside it", () => {
    // A row in the `blocked` section reads "Blocked"; the heading must agree.
    expect(presentBoardSection("blocked")).toBe(presentRunStatus("waiting").word);
    expect(presentBoardSection("running")).toBe(presentRunStatus("running").word);
    expect(presentBoardSection("done")).toBe(presentRunStatus("done").word);
    expect(presentBoardSection("ready_for_review")).toBe(
      presentLifecycle("needs_review").word
    );
  });

  it("treats the two live-delegate spellings of working as one state", () => {
    // The activity timer emits `running`, the hook layer `working`.
    expect(presentLiveDelegate("running")).toEqual(presentLiveDelegate("working"));
  });

  it("only colours a board reason when it is danger", () => {
    expect(presentReasonTone("danger")).toBe(toneColor("bad"));
    for (const tone of ["active", "warn", "accent", "success", "subtle"] as const) {
      expect(presentReasonTone(tone)).toBe(toneColor("quiet"));
    }
  });

  it("does not assert a verdict for an unknown validation status", () => {
    expect(presentValidation("passed")).toBe("settled");
    expect(presentValidation("failed")).toBe("bad");
    expect(presentValidation("unverified")).toBe("attention");
    expect(presentValidation("skipped")).toBe("quiet");
    // The parser's tolerance member: a durable log carried a word this build
    // doesn't know. Rendered, but never asserted as a verdict.
    expect(presentValidation("unknown")).toBe("quiet");
    expect(presentValidation(null)).toBe("quiet");
    expect(presentValidation(undefined)).toBe("quiet");
  });
});

describe("runs.ts tables derive from the vocabulary", () => {
  it("labels and colours cannot drift from each other", () => {
    // These were eight hand-maintained tables. They are now projections, so a
    // state's word and its colour are decided in the same place.
    for (const s of STATUS_ORDER) {
      expect(STATUS_LABEL[s]).toBe(presentRunStatus(s).word);
      expect(STATUS_COLOR[s]).toBe(toneColor(presentRunStatus(s).tone));
    }
    for (const s of LIFECYCLE_STATUSES) {
      expect(LIFECYCLE_LABEL[s]).toBe(presentLifecycle(s).word);
    }
    for (const s of BOARD_SECTION_ORDER) {
      expect(BOARD_SECTION_LABEL[s]).toBe(presentBoardSection(s));
    }
  });

  it("covers every member of each union", () => {
    expect(Object.keys(STATUS_LABEL).sort()).toEqual([...STATUS_ORDER].sort());
    expect(Object.keys(LIFECYCLE_LABEL).sort()).toEqual([...LIFECYCLE_STATUSES].sort());
    expect(Object.keys(BOARD_SECTION_LABEL).sort()).toEqual([...BOARD_SECTION_ORDER].sort());
  });
});

import { expect, it } from "vitest";
import { expandArtifactRequest } from "./useArtifactInspector";
import type { CheckpointEntry } from "../agent/types";

const entry = (oldContent: string, newContent: string, ts: number, extra: Partial<CheckpointEntry> = {}): CheckpointEntry => ({
  toolCallId: String(ts), workspaceRoot: "/project", path: "a.ts",
  oldContent, newContent, ts, isCreate: false, ...extra,
});

it("combines repeated edits into the full before/after diff", () => {
  const entries = [entry("B", "C", 2), entry("A", "B", 1)];
  const result = expandArtifactRequest({ kind: "checkpoint-set", runId: "run", title: "Review", entries });
  expect(result).toEqual([{ kind: "diff", runId: "run", workspaceRoot: "/project", path: "a.ts", original: "A", modified: "C", isCreate: false }]);
  expect(entries[0].oldContent).toBe("B");
});

it("keeps workspaces separate and preserves file creation across later edits", () => {
  const result = expandArtifactRequest({ kind: "checkpoint-set", runId: "run", title: "Review", entries: [
    entry("", "A", 1, { isCreate: true }), entry("X", "Y", 3, { workspaceRoot: "/other" }), entry("A", "B", 2),
  ] });
  expect(result).toHaveLength(2);
  expect(result).toContainEqual(expect.objectContaining({ workspaceRoot: "/project", original: "", modified: "B", isCreate: true }));
  expect(result).toContainEqual(expect.objectContaining({ workspaceRoot: "/other", original: "X", modified: "Y" }));
});

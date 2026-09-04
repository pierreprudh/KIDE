import { describe, expect, it } from "vitest";
import type { CoordinationEnvelopeSnapshot } from "../../agent/coordination";
import { exchangeBetween } from "./PeerLink";

function envelope(id: string, from: string, to: string, createdAtMs: number): CoordinationEnvelopeSnapshot {
  return {
    envelope: { id, from: { type: "run", runId: from }, toRunId: to, kind: "instruction", body: id, sourceRefs: [], createdAtMs },
    deliveryState: "acknowledged",
  };
}

describe("exchangeBetween", () => {
  it("keeps only what travelled between the two threads, oldest first", () => {
    const all = [
      envelope("late_reply", "b", "a", 30),
      envelope("to_other", "a", "c", 20),
      envelope("first", "a", "b", 10),
      { ...envelope("from_operator", "a", "b", 5), envelope: { ...envelope("from_operator", "a", "b", 5).envelope, from: { type: "operator" as const } } },
    ];
    expect(exchangeBetween(all, "a", "b").map((e) => e.envelope.id)).toEqual(["first", "late_reply"]);
  });

  it("lists self-talk once", () => {
    const all = [envelope("ping", "a", "a", 1)];
    expect(exchangeBetween(all, "a", "a")).toHaveLength(1);
  });
});

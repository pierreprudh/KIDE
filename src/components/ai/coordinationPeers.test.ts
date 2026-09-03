import { describe, expect, it } from "vitest";
import type { Msg } from "./types";
import {
  coordinationPeersOf,
  lastCoordinationDirection,
  parseDeliveryReason,
  peerName,
  shortRunId,
} from "./coordinationPeers";

describe("parseDeliveryReason", () => {
  it("reads the harness's one-line delivery record, singular and plural", () => {
    expect(parseDeliveryReason("Agent message delivered: question from @run_parent (env_1)")).toEqual([
      { kind: "question", from: "run_parent", envelopeId: "env_1" },
    ]);
    expect(
      parseDeliveryReason(
        "Agent messages delivered: instruction from operator (env_2); answer from @run_child (env_3)",
      ),
    ).toEqual([
      { kind: "instruction", from: "operator", envelopeId: "env_2" },
      { kind: "answer", from: "run_child", envelopeId: "env_3" },
    ]);
  });

  it("leaves every other steering line alone", () => {
    expect(parseDeliveryReason("Loop detected — `read_file` called 3×")).toBeNull();
    expect(parseDeliveryReason("Agent message delivered: garbage")).toBeNull();
  });
});

describe("peer names", () => {
  it("uses the thread title when the Run is a stored conversation", () => {
    const titles = new Map([["run_parent", { title: "Fix the parser before the release", provider: null, model: null }]]);
    expect(peerName("run_parent", titles)).toBe("Fix the parser before the release");
    expect(peerName("operator", titles)).toBe("operator");
  });

  it("falls back to a shortened id for Runs without a thread", () => {
    const id = "c3f2a9d0-1234-4567-89ab-0123456789ab";
    expect(peerName(id, new Map())).toBe(shortRunId(id));
    expect(shortRunId(id)).toBe("c3f2a9d0…6789ab");
    expect(shortRunId("run_child")).toBe("run_child");
  });
});

describe("coordinationPeersOf", () => {
  it("collects who this conversation spoke with, on both sides, once each", () => {
    const msgs: Msg[] = [
      {
        role: "assistant",
        content: "",
        toolCalls: [
          { name: "agent_list", args: {} },
          { name: "agent_send", args: { toRunId: "run_b", body: "Hi" } },
          { name: "read_file", args: { path: "x" } },
        ],
      },
      { role: "system", content: "", steering: { reason: "Agent message delivered: answer from @run_b (env_9)" } },
      { role: "system", content: "", steering: { reason: "Agent message delivered: instruction from operator (env_10)" } },
      { role: "assistant", content: "", toolCalls: [{ name: "agent_wait", args: { fromRunId: "run_c" } }] },
    ];
    expect(coordinationPeersOf(msgs)).toEqual(["run_b", "run_c"]);
  });

  it("reports which way the latest exchange went", () => {
    const sent: Msg = { role: "assistant", content: "", toolCalls: [{ name: "agent_send", args: { toRunId: "run_b", body: "Hi" } }] };
    const received: Msg = { role: "system", content: "", steering: { reason: "Agent message delivered: answer from @run_b (env_9)" } };
    expect(lastCoordinationDirection([sent])).toBe("out");
    expect(lastCoordinationDirection([sent, received])).toBe("in");
    expect(lastCoordinationDirection([received, sent])).toBe("out");
    expect(lastCoordinationDirection([{ role: "user", content: "hello" }])).toBeNull();
  });
});

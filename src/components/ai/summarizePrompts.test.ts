import { describe, expect, it } from "vitest";
import type { Msg } from "./types";
import {
  fallbackSummary,
  parseClassify,
  parseSummaryResponse,
  splitIntoChunks,
} from "./summarizePrompts";

describe("parseSummaryResponse", () => {
  it("parses a well-formed three-block response", () => {
    const text = [
      "NOTES:",
      "Refactored the tab bar. One test still failing.",
      "",
      "DECISIONS:",
      "- keep inline styles",
      "* derive the index from the store",
      "",
      "GOAL:",
      "Fix the tab drift bug.",
    ].join("\n");
    const parsed = parseSummaryResponse(text);
    expect(parsed.notes).toBe("Refactored the tab bar. One test still failing.");
    expect(parsed.decisions).toEqual([
      "keep inline styles",
      "derive the index from the store",
    ]);
    expect(parsed.goal).toBe("Fix the tab drift bug.");
  });

  it("returns empty fields when a section is missing, not garbage", () => {
    const parsed = parseSummaryResponse("NOTES:\nJust notes, no other blocks.");
    expect(parsed.notes).toBe("Just notes, no other blocks.");
    expect(parsed.decisions).toEqual([]);
    expect(parsed.goal).toBe("");
  });

  // The shape of the old every-summary-came-back-empty bug: the model reply
  // arrives as an empty string. The parser must degrade to all-empty fields
  // (callers detect that and use the deterministic fallback), never throw.
  it("survives an empty model reply", () => {
    const parsed = parseSummaryResponse("");
    expect(parsed).toEqual({ notes: "", decisions: [], goal: "", filesTouched: [] });
  });

  it("ignores headers that are not alone on their line", () => {
    const parsed = parseSummaryResponse("Sure! NOTES: everything went fine.");
    expect(parsed.notes).toBe("");
  });
});

describe("parseClassify", () => {
  it("parses a reusable classification", () => {
    const cls = parseClassify(
      "REUSABLE: yes\nNAME: Review Strict PR\nTITLE: Strict PR review\nDESCRIPTION: Use when reviewing PRs.\n"
    );
    expect(cls).toEqual({
      reusable: true,
      slug: "review-strict-pr",
      title: "Strict PR review",
      description: "Use when reviewing PRs.",
    });
  });

  it("returns null for REUSABLE: no", () => {
    expect(parseClassify("REUSABLE: no")).toBeNull();
  });

  it("returns null when the slug reduces to nothing", () => {
    expect(parseClassify("REUSABLE: yes\nNAME: ---\nTITLE: x")).toBeNull();
  });

  it("fills title and description from the slug when missing", () => {
    const cls = parseClassify("REUSABLE: yes\nNAME: deploy-ritual");
    expect(cls?.title).toBe("deploy-ritual");
    expect(cls?.description).toBe("Auto-generated from a session.");
  });
});

describe("splitIntoChunks", () => {
  it("returns the text whole when it fits", () => {
    expect(splitIntoChunks("hello", 10)).toEqual(["hello"]);
  });

  it("returns no chunks for empty text", () => {
    expect(splitIntoChunks("", 10)).toEqual([]);
  });

  it("splits oversized input into max-size chunks that reassemble losslessly", () => {
    const text = "x".repeat(25);
    const chunks = splitIntoChunks(text, 10);
    expect(chunks.map((c) => c.length)).toEqual([10, 10, 5]);
    expect(chunks.join("")).toBe(text);
  });
});

describe("fallbackSummary", () => {
  const msgs: Msg[] = [
    { role: "user", content: "Fix the flaky tab test" },
    {
      role: "assistant",
      content: "On it.",
      toolCalls: [
        { id: "1", name: "write_file", args: { path: "src/TabBar.tsx", content: "…" } } as any,
      ],
    },
    { role: "user", content: "Also update the changelog" },
  ];

  it("builds a deterministic summary from requests and touched files", () => {
    const text = fallbackSummary(msgs);
    expect(text).toContain("Goal: Fix the flaky tab test");
    expect(text).toContain("Also asked: Also update the changelog");
    expect(text).toContain("Files changed: src/TabBar.tsx");
    expect(text).toContain("3 earlier messages folded");
  });

  it("never returns empty, even for an empty slice", () => {
    expect(fallbackSummary([]).length).toBeGreaterThan(0);
  });
});

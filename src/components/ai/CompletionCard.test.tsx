import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CompletionCard, ResultEvidence } from "./CompletionCard";
import type { RunCompletion } from "../../agent/completion";

const completion: RunCompletion = { runId: "r", completedAt: 1, outcome: "Updated settings.", files: [], commands: [], warnings: [] };
const render = (value: RunCompletion) => renderToStaticMarkup(<CompletionCard completion={value} onReview={() => {}} onRequestChanges={() => {}} />);
const renderIsland = (value: RunCompletion, compact = false) => renderToStaticMarkup(
  <CompletionCard variant="island" compact={compact} completion={value} onReview={() => {}} onRequestChanges={() => {}} />,
);
// The sheet only exists while open, and there is no DOM here to click in — so
// the evidence both surfaces share is asserted directly.
const renderEvidence = (value: RunCompletion) => renderToStaticMarkup(
  <ResultEvidence completion={value} onReview={() => {}} onRequestChanges={() => {}} onDone={() => {}} />,
);

describe("CompletionCard", () => {
  it("renders nothing for empty evidence, including older saved completions", () => {
    expect(render(completion)).toBe("");
    expect(renderIsland(completion)).toBe("");
  });
  it("does not interrupt successful command-only work", () => {
    expect(render({ ...completion, commands: [{ id: "c", label: "git status", status: "passed" }] })).toBe("");
  });
  it("offers review for changed files but keeps the evidence out of the page until asked", () => {
    const html = render({ ...completion, files: ["src/app.tsx"], commands: [{ id: "c", label: "npm test", status: "failed" }] });
    expect(html).toContain("Review result");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toMatch(/<dialog/);
    expect(html).not.toContain("Updated settings.");
    expect(html).not.toContain("Command results");
    expect(html).not.toContain("Review changes");
  });
  it("never presents a stopped attempt as a result", () => {
    const stopped = { ...completion, files: ["src/app.tsx"], stopped: true, warnings: ["The run stopped before finishing — this work is partial."] };
    expect(render(stopped)).toContain("Review partial work");
    expect(render(stopped)).not.toContain("Review result");
    expect(renderIsland(stopped)).toContain("Partial work");
    expect(renderEvidence(stopped)).toContain("stopped before finishing");
  });
});

describe("the island card", () => {
  const withFiles = { ...completion, files: ["src/app.tsx", "src/time.ts"] };

  it("waits in the column as a header, with no sheet to open", () => {
    const html = renderIsland(withFiles);
    expect(html).toContain("klide-result-island");
    expect(html).not.toContain("klide-result-scrim");
    expect(html).not.toMatch(/<dialog/);
    expect(html).toContain("Result");
    expect(html).toContain("2 files");
    // Closed, the card is only its header — the evidence mounts on open, so
    // the column carries one row until the reader asks for the rest.
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("klide-result-island-panel");
    expect(html).not.toContain("Review changes");
  });
  // A narrow column is a corner: one mark and nothing beside it. The count,
  // the attention dot and the chevron all go, and what they said has to
  // survive in the header's name and tooltip instead.
  it("keeps one mark when the column is narrow", () => {
    const html = renderIsland(withFiles, true);
    expect(html).not.toContain("klide-result-island-title");
    expect(html).not.toContain("klide-result-meta");
    expect(html).not.toContain("klide-result-island-chevron");
    expect(html.split("<svg").length - 1).toBe(1);
    expect(html).toContain("Review result · 2 files");
    expect(html).toContain('aria-label="Expand result, 2 files"');
  });
  it("puts attention on the mark rather than a dot beside it", () => {
    const html = renderIsland({ ...withFiles, warnings: ["Check the migration"] }, true);
    expect(html).not.toContain("klide-result-attention-dot");
    expect(html).toContain('data-attention="1"');
    expect(html).toContain("1 item to review");
  });
});

describe("ResultEvidence", () => {
  it("lists changed files with a way into each one", () => {
    const html = renderEvidence({ ...completion, files: ["src/app.tsx"] });
    expect(html).toContain("Changes");
    expect(html).toContain("app.tsx");
    expect(html).toContain("Review changes");
    expect(html).not.toContain("Command results");
  });
  it.each(["failed", "unknown"] as const)("keeps %s command evidence accessible without edits", (status) => {
    const html = renderEvidence({ ...completion, commands: [{ id: "c", label: "npm test", status, output: "<script>bad</script>" }] });
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("Changed files");
    expect(html).not.toContain("Review changes");
  });
  it("keeps permission warnings accessible", () => {
    expect(renderEvidence({ ...completion, warnings: ["Permission denied"] })).toContain("Permission denied");
  });
});

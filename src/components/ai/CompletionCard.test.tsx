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
const renderEvidence = (value: RunCompletion, onOpenArtifact?: (path: string) => void) => renderToStaticMarkup(
  <ResultEvidence completion={value} onReview={() => {}} onOpenArtifact={onOpenArtifact}
    onRequestChanges={() => {}} onDone={() => {}} />,
);
const DECK = { path: "decks/Q3 review.pptx", bytes: 40_960, created: true };

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
  // "A document or review should stay in icons": at rest the entry is one mark
  // and nothing else — not even its own dismiss, which kept the pill as wide
  // as two things even when hidden. Putting a resting result away is the
  // column's close; the card's own arrives with the open card.
  it("rests as one mark at either size, with no control beside it", () => {
    for (const compact of [false, true]) {
      const html = renderToStaticMarkup(
        <CompletionCard variant="island" compact={compact} completion={withFiles}
          onReview={() => {}} onRequestChanges={() => {}} onDismiss={() => {}} />,
      );
      expect(html).toContain('data-resting="1"');
      expect(html.split("<svg").length - 1).toBe(1);
      expect(html).not.toContain("klide-result-island-close");
      expect(html).not.toContain("klide-result-island-title");
    }
  });
  it("offers no dismissal when the host has nowhere to put the state", () => {
    expect(renderIsland(withFiles)).not.toContain("klide-result-island-close");
  });
  it("puts attention on the mark rather than a dot beside it", () => {
    const html = renderIsland({ ...withFiles, warnings: ["Check the migration"] }, true);
    expect(html).not.toContain("klide-result-attention-dot");
    expect(html).toContain('data-attention="1"');
    expect(html).toContain("1 item to review");
  });
});

describe("documents a command produced", () => {
  it("lists them with their size, apart from the changes", () => {
    const html = renderEvidence({ ...completion, artifacts: [DECK] }, () => {});
    expect(html).toContain("Documents");
    expect(html).toContain("Q3 review.pptx");
    expect(html).toContain("41 KB");
    // No diff and no checkpoint behind a produced file: it must not arrive
    // where the reviewable edits are.
    expect(html).not.toContain("Changes");
    expect(html).not.toContain("Review changes");
  });

  it("says which of the two things the row will do", () => {
    expect(renderEvidence({ ...completion, artifacts: [DECK] }, () => {}))
      .toContain("Open Q3 review.pptx in its app");
    expect(renderEvidence({ ...completion, artifacts: [{ path: "notes.md", bytes: 900, created: true }] }, () => {}))
      .toContain("Read notes.md");
  });

  it("still lists them when the host offers no way to open one", () => {
    // The footer's own buttons stay; it is the row that stops being one.
    const html = renderEvidence({ ...completion, artifacts: [DECK] });
    expect(html).toContain("Q3 review.pptx");
    expect(html).not.toContain("Open Q3 review.pptx in its app");
    expect(html).not.toContain("↗</span></button>");
  });

  it("earns the card on its own", () => {
    // Nothing edited, no failing command: without the document this run would
    // draw no entry at all.
    expect(render({ ...completion, artifacts: [DECK] })).toContain("Review result");
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

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CompletionCard } from "./CompletionCard";
import type { RunCompletion } from "../../agent/completion";

const completion: RunCompletion = { runId: "r", completedAt: 1, outcome: "Updated settings.", files: [], commands: [], warnings: [] };
const render = (value: RunCompletion) => renderToStaticMarkup(<CompletionCard completion={value} onReview={() => {}} onRequestChanges={() => {}} />);

describe("CompletionCard", () => {
  it("renders nothing for empty evidence, including older saved completions", () => {
    expect(render(completion)).toBe("");
  });
  it("does not interrupt successful command-only work", () => {
    expect(render({ ...completion, commands: [{ id: "c", label: "git status", status: "passed" }] })).toBe("");
  });
  it("offers review for changed files but leaves the drawer closed", () => {
    const html = render({ ...completion, files: ["src/app.tsx"] });
    expect(html).toContain("Review result");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toMatch(/<dialog[^>]*\sopen(?:[\s=>])/);
    expect(html).not.toContain("Updated settings.");
    expect(html).not.toContain("Not recorded");
    expect(html).not.toContain("Command results");
  });
  it.each(["failed", "unknown"] as const)("keeps %s command evidence accessible without edits", (status) => {
    const html = render({ ...completion, commands: [{ id: "c", label: "npm test", status, output: "<script>bad</script>" }] });
    expect(html).toContain("Review result");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("Changed files");
    expect(html).not.toContain("Review changes");
  });
  it("never presents a stopped attempt as a result", () => {
    const html = render({ ...completion, files: ["src/app.tsx"], stopped: true, warnings: ["The run stopped before finishing — this work is partial."] });
    expect(html).toContain("Review partial work");
    expect(html).not.toContain("Review result");
    expect(html).toContain("Partial work");
    expect(html).toContain("stopped before finishing");
  });
  it("keeps permission warnings accessible", () => {
    expect(render({ ...completion, warnings: ["Permission denied"] })).toContain("Permission denied");
  });
});

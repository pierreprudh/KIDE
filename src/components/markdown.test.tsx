import { Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "./markdown";

const html = (text: string, streaming?: boolean) =>
  renderToStaticMarkup(<Fragment>{renderMarkdown(text, streaming ? { streaming } : undefined)}</Fragment>);

describe("renderMarkdown streaming tail", () => {
  it("renders a finished message as plain text — no per-word spans", () => {
    expect(html("Pistachio is up 23% this month.")).not.toContain("ai-word-in");
  });

  it("wraps only the trailing plain-text run of the last block, one span per word", () => {
    const out = html("First paragraph.\n\nSales are **up** this month", true);
    const first = out.indexOf("First paragraph.");
    const spans = out.match(/class="ai-word-in"/g) ?? [];
    // "First paragraph." stays plain; " this month" → two word spans.
    expect(out.slice(0, first + 20)).not.toContain("ai-word-in");
    expect(spans).toHaveLength(2);
    expect(out).toContain('<span class="ai-word-in">this </span><span class="ai-word-in">month</span>');
  });

  it("keeps a word's key while the text grows, so the node survives the next batch", () => {
    const a = renderMarkdown("Sales are up", { streaming: true });
    const b = renderMarkdown("Sales are up this month", { streaming: true });
    const keys = (nodes: ReturnType<typeof renderMarkdown>) =>
      nodes.flatMap((n) => (typeof n === "string" ? [] : (n.props as { children: unknown[] }).children))
        .filter((c): c is { key: string } => typeof c === "object" && c !== null && "key" in c)
        .map((c) => c.key);
    expect(keys(b).slice(0, keys(a).length)).toEqual(keys(a));
  });

  it("treats a list item the model is still typing as the tail", () => {
    const out = html("- done item\n- still typing", true);
    expect(out.match(/class="ai-word-in"/g)).toHaveLength(2);
    expect(out).toContain("done item</li>");
  });

  it("never animates prose that a code fence already closed off", () => {
    const out = html("Before the fence\n\n```ts\nconst a = 1;\n```", true);
    expect(out).not.toContain("ai-word-in");
  });
});

// The parse cache is what lets a settled message cost nothing on the ~28
// renders a second the panel does while a Run streams. Its two exclusions are
// deliberate: a streaming tail changes every tick, and a `renderTool` hook
// makes the output depend on the caller rather than the text.
describe("renderMarkdown parse cache", () => {
  it("hands back the same nodes for the same settled text", () => {
    const text = "Some **bold**, some `code`, and a [link](https://example.com).\n\n- one\n- two";
    const first = renderMarkdown(text);
    expect(renderMarkdown(text)).toBe(first);
    expect(renderMarkdown(text, {})).toBe(first);
  });

  it("parses distinct text distinctly", () => {
    expect(renderMarkdown("alpha")).not.toBe(renderMarkdown("beta"));
  });

  it("does not cache a streaming tail", () => {
    const text = "words still arriving";
    expect(renderMarkdown(text, { streaming: true })).not.toBe(renderMarkdown(text, { streaming: true }));
    // Once settled, the same text caches like any other.
    expect(renderMarkdown(text)).toBe(renderMarkdown(text));
  });

  it("does not cache a tool-marker render", () => {
    const text = "[tool: read_file src/App.tsx]";
    const renderTool = () => null;
    expect(renderMarkdown(text, { renderTool })).not.toBe(renderMarkdown(text, { renderTool }));
  });
});

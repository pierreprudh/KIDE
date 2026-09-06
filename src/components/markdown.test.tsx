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

import { Fragment } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Msg } from "./types";
import { extractThinking, renderMessageBody, ThinkingBlock } from "./ChatMessage";

function occurrences(text: string, needle: string): number {
  return text.split(needle).length - 1;
}

describe("tool-run thinking", () => {
  it.each([
    {
      name: "structured thinking",
      message: { role: "assistant", content: "", thinking: "Inspect the workspace." } satisfies Msg,
      expected: "Inspect the workspace.",
    },
    {
      name: "inline think block",
      message: { role: "assistant", content: "<think>Find the relevant symbol.</think>" } satisfies Msg,
      expected: "Find the relevant symbol.",
    },
    {
      name: "plan JSON",
      message: {
        role: "assistant",
        content: JSON.stringify({ analysis: "Verify the change.", plan: "Run the tests.", commands: [] }),
      } satisfies Msg,
      expected: "Verify the change.\n\nRun the tests.",
    },
  ])("extracts $name", ({ message, expected }) => {
    expect(extractThinking(message)).toBe(expected);
  });

  it("renders one hoisted copy when the folded message body remains mounted", () => {
    const message: Msg = {
      role: "assistant",
      content: "",
      thinking: "Inspect the workspace.",
      toolCalls: [{ name: "read_file", args: { path: "src/App.tsx" } }],
    };
    const thinking = extractThinking(message);

    const html = renderToStaticMarkup(
      <Fragment>
        <ThinkingBlock text={thinking} streaming={false} />
        {renderMessageBody(message, false, { hideThinking: true })}
      </Fragment>,
    );

    expect(occurrences(html, "Thought process")).toBe(1);
    expect(occurrences(html, "Inspect the workspace.")).toBe(1);
    expect(html).toContain("read_file");
  });

  it("keeps the original thinking block when the message is not folded", () => {
    const message: Msg = {
      role: "assistant",
      content: "Answer after checking.",
      thinking: "Inspect the workspace.",
    };

    const html = renderToStaticMarkup(renderMessageBody(message));

    expect(occurrences(html, "Thought process")).toBe(1);
    expect(occurrences(html, "Inspect the workspace.")).toBe(1);
    expect(html).toContain("Answer after checking.");
  });
});

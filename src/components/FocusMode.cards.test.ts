// The mark on a "Continue where you left off" card. The card used to draw a
// mark only for a delegate or a recognisable model brand, so every Ollama,
// MLX, or self-hosted conversation resumed from a blank corner. These are the
// precedence rules that answer "what ran this" for the rest of them.

import { describe, expect, it } from "vitest";

import { resumeMark } from "./FocusMode";

describe("resume card mark", () => {
  it("lets the delegate outrank the model it happened to pick", () => {
    // The CLI stores the `default` sentinel far more often than a model id,
    // and what you resumed is a Claude Code conversation either way.
    expect(resumeMark("default", "claude-code")).toMatchObject({
      label: "Claude Code",
      bare: true,
    });
    expect(resumeMark("claude-sonnet-4-6", "claude-code").label).toBe("Claude Code");
  });

  it("brands a hosted conversation by the model's maker", () => {
    expect(resumeMark("claude-sonnet-4-6", "anthropic")).toMatchObject({
      label: "Anthropic",
      bare: true,
    });
  });

  it("keeps a model with its own maker mark unbranded by the host", () => {
    // `llama3.1:8b` runs on Ollama, but Meta made it — the maker still wins.
    expect(resumeMark("llama3.1:8b", "ollama").label).toBe("Llama");
  });

  it("falls back to the provider that hosted an unbranded model", () => {
    // Klide's own fine-tune has no maker mark of its own — but it ran on
    // Ollama, and that is the honest thing to draw.
    expect(resumeMark("pierreprudh/klide-8b", "ollama")).toMatchObject({
      label: "Ollama",
      bare: true,
    });
  });

  it("names a self-hosted endpoint rather than drawing nothing", () => {
    const mark = resumeMark("internal-8b", "custom:my-gateway");
    expect(mark.bare).toBe(true);
    expect(mark.label).toBe("my-gateway");
  });

  it("wears Klide's own mark when there is nothing else to brand", () => {
    expect(resumeMark(null, null)).toMatchObject({ label: "Klide", bare: false });
    expect(resumeMark("some-unknown-model", null).label).toBe("Klide");
  });
});

// The mark on a "Continue where you left off" card. The card used to draw a
// mark only for a delegate or a recognisable model brand, so every Ollama,
// MLX, or self-hosted conversation resumed from a blank corner. These are the
// precedence rules that answer "what ran this" for the rest of them.

import { describe, expect, it } from "vitest";

import { resumeMark } from "./FocusMode";

describe("resume card mark", () => {
  it("lets the delegate lead, and names the maker beside it", () => {
    // The CLI stores the `default` sentinel far more often than a model id —
    // and the maker is still knowable when it does, because Claude Code runs
    // nothing but Anthropic's models. Drawing the pair only for the turns that
    // happened to pin an id made one agent wear two different marks.
    expect(resumeMark("default", "claude-code").label).toBe("Claude Code · Anthropic");
    // When the id does name a maker, the CLI no longer erases it: OpenCode
    // drives ~30 other makers' models, so "an OpenCode conversation" alone
    // leaves out what actually replied.
    expect(resumeMark("claude-sonnet-4-6", "claude-code").label).toBe("Claude Code · Anthropic");
    expect(resumeMark("opencode-go/kimi-k3", "opencode").label).toBe("OpenCode · Kimi");
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
    // Klide's logo is a brand mark like any other, so it is worn bare too.
    expect(resumeMark(null, null)).toMatchObject({ label: "Klide", bare: true });
    expect(resumeMark("some-unknown-model", null).label).toBe("Klide");
  });
});

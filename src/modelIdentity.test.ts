import { describe, expect, it } from "vitest";
import { conversationMark, modelIdentity } from "./modelIdentity";

describe("modelIdentity", () => {
  it.each([
    ["mlx-community/Qwen3-30B", "Qwen"],
    ["openrouter/deepseek/deepseek-v4", "DeepSeek"],
    ["claude-sonnet-4-6", "Anthropic"],
    ["openai/gpt-5.6", "OpenAI"],
    ["gemma-3-27b", "Google"],
    ["grok-4", "xAI"],
    ["moonshot/kimi-k2", "Kimi"],
    ["z-ai/glm-5", "Z.AI"],
    // Delegate CLIs namespace their catalogue `<route>/<model>`, so the maker
    // sits behind a prefix that is not the maker (OpenCode's own gateway).
    ["opencode-go/kimi-k3", "Kimi"],
    ["opencode-go/glm-5.2", "Z.AI"],
    ["opencode-go/gpt-5.6-luna", "OpenAI"],
    ["opencode-go/grok-4.5", "xAI"],
    ["opencode-go/minimax-m3", "MiniMax"],
    ["opencode/deepseek-v4-flash-free", "DeepSeek"],
  ])("recognizes %s as %s", (model, maker) => {
    expect(modelIdentity(model)?.name).toBe(maker);
  });

  // A gateway id names the maker in its vendor segment, and the model half can
  // say nothing at all — which is how these drew no mark before.
  it.each([
    ["openai/chatgpt-4o-latest", "OpenAI"],
    ["anthropic/claude-next", "Anthropic"],
    ["google/palm-2", "Google"],
    ["mistralai/pixtral-large", "Mistral AI"],
    ["meta-llama/maverick-17b", "Llama"],
    ["qwen/qwq-32b", "Qwen"],
    ["moonshotai/moonlight-16b", "Kimi"],
    ["x-ai/sherlock-alpha", "xAI"],
    // OpenRouter's variant prefix rides in front of the vendor.
    ["~deepseek/deepseek-v4-flash-latest", "DeepSeek"],
    // The model half names no maker at all here, so the vendor carries it.
    ["sakana/fugu-ultra", "Sakana AI"],
  ])("reads the maker from the vendor segment of %s", (model, maker) => {
    expect(modelIdentity(model)?.name).toBe(maker);
  });

  // The model half is the more specific evidence, so it outranks the vendor:
  // a Nemotron is still a Llama, and the host org is not its maker.
  it("prefers the model half over the vendor segment", () => {
    expect(modelIdentity("nvidia/llama-3.3-nemotron-super-49b")?.name).toBe("Llama");
  });

  // A router is not a maker, and neither is a local namespace.
  it.each(["openrouter/auto", "openrouter/horizon-beta", "nousresearch/hermes-4-70b", "pierreprudh/klide-8b:latest"])(
    "leaves %s unbranded",
    (model) => {
      expect(modelIdentity(model)).toBeNull();
    },
  );

  it.each([null, undefined, "", "default", "auto", "unknown-model", "phi-4"])(
    "does not invent an identity for %s",
    (model) => {
      expect(modelIdentity(model)).toBeNull();
    },
  );
});

describe("conversationMark", () => {
  it("names the maker when the model id does", () => {
    expect(conversationMark("deepseek/deepseek-v4-flash", "openrouter", 15)?.label).toBe(
      "DeepSeek",
    );
  });

  // The arm the rail was missing: a routed model whose vendor Klide has no mark
  // for still ran somewhere, and that somewhere has one. Drawing nothing read
  // as metadata that had failed to load.
  it("falls back to the provider that hosted an unbranded model", () => {
    expect(conversationMark("openrouter/auto", "openrouter", 15)?.label).toBe("OpenRouter");
    expect(conversationMark("hermes-4-70b", "ollama", 15)?.label).toBe("Ollama");
  });

  it("leads with the CLI for a delegate thread, whatever it ran", () => {
    expect(conversationMark("default", "claude-code", 24)?.label).toBe("Claude Code");
    expect(conversationMark("opencode-go/kimi-k3", "opencode", 24)?.label).toBe(
      "OpenCode · Kimi",
    );
  });

  it("has nothing to draw when neither the model nor the provider is known", () => {
    expect(conversationMark("unknown-model", null, 15)).toBeNull();
    expect(conversationMark(null, undefined, 15)).toBeNull();
  });
});

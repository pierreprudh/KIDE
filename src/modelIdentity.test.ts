import { describe, expect, it } from "vitest";
import { modelIdentity } from "./modelIdentity";

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

  it.each([null, undefined, "", "default", "auto", "unknown-model", "phi-4"])(
    "does not invent an identity for %s",
    (model) => {
      expect(modelIdentity(model)).toBeNull();
    },
  );
});

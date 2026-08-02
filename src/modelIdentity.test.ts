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

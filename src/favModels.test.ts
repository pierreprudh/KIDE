import { beforeEach, describe, expect, it, vi } from "vitest";
import { memoryStorage } from "./testStorage";
import { allFavModels, favModelsFor, toggleFavModel } from "./favModels";

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
});

describe("allFavModels — what an Auto run sends the router", () => {
  it("lists every star across providers, oldest first", () => {
    toggleFavModel("anthropic", "claude-sonnet-4-6");
    toggleFavModel("ollama", "qwen3:8b");
    toggleFavModel("openrouter", "deepseek/deepseek-chat");
    expect(allFavModels()).toEqual([
      { provider: "anthropic", model: "claude-sonnet-4-6" },
      { provider: "ollama", model: "qwen3:8b" },
      { provider: "openrouter", model: "deepseek/deepseek-chat" },
    ]);
  });

  it("splits on the first separator only, so a model id may carry spaces", () => {
    // Custom endpoints let the user type any model string; the provider half
    // never contains a space, so the first one is the boundary.
    toggleFavModel("custom:gateway", "my model v2");
    expect(allFavModels()).toEqual([{ provider: "custom:gateway", model: "my model v2" }]);
  });

  it("drops a star as soon as it is toggled off", () => {
    toggleFavModel("anthropic", "claude-sonnet-4-6");
    toggleFavModel("anthropic", "claude-sonnet-4-6");
    expect(allFavModels()).toEqual([]);
    expect(favModelsFor("anthropic")).toEqual([]);
  });

  it("ignores a malformed key rather than inventing a pair", () => {
    localStorage.setItem("klide.favoriteModels", JSON.stringify(["no-separator", " leading"]));
    expect(allFavModels()).toEqual([]);
  });
});

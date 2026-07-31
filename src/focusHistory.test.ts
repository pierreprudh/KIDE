import { describe, expect, it } from "vitest";
import { providerHistoryExpanded } from "./focusHistory";

describe("providerHistoryExpanded", () => {
  it("reveals the newest worked provider even when the primary panel uses another provider", () => {
    expect(
      providerHistoryExpanded(undefined, "openrouter", "mlx", "openrouter"),
    ).toBe(true);
  });

  it("preserves an explicit disclosure choice", () => {
    expect(providerHistoryExpanded(false, "openrouter", "mlx", "openrouter")).toBe(false);
    expect(providerHistoryExpanded(true, "openrouter", "mlx", "mlx")).toBe(true);
  });
});

import { describe, expect, it } from "vitest";
import { hostModelAdoption, offlineModelFallback } from "./modelSelection";

describe("hostModelAdoption", () => {
  it("leaves the pair alone on mount — the restored Conversation owns it", () => {
    expect(
      hostModelAdoption({
        hostModel: "pierreprudh/lfm2.5-8b-a1b:latest",
        lastHostModel: undefined,
        sessionModel: "qwen3.8:27b-mlx",
      }),
    ).toBeNull();
  });

  it("ignores an unchanged host prop, however stale it is", () => {
    // The reported defect: App re-renders for unrelated reasons (a git status
    // refresh, a run event) with a layout model saved before the Provider's
    // model list corrected the pick. Nothing was picked, so nothing changes.
    expect(
      hostModelAdoption({
        hostModel: "pierreprudh/lfm2.5-8b-a1b:latest",
        lastHostModel: "pierreprudh/lfm2.5-8b-a1b:latest",
        sessionModel: "qwen3.8:27b-mlx",
      }),
    ).toBeNull();
  });

  it("adopts a host model that actually changed — the hero/host pick", () => {
    expect(
      hostModelAdoption({
        hostModel: "claude-sonnet-5",
        lastHostModel: "qwen3.8:27b-mlx",
        sessionModel: "qwen3.8:27b-mlx",
      }),
    ).toBe("claude-sonnet-5");
  });

  it("is a no-op when the changed host prop already matches the session", () => {
    // The mount push-up comes back as a prop change; adopting it would be a
    // pointless transition (and a pointless re-persist of the Conversation).
    expect(
      hostModelAdoption({
        hostModel: "qwen3.8:27b-mlx",
        lastHostModel: "pierreprudh/lfm2.5-8b-a1b:latest",
        sessionModel: "qwen3.8:27b-mlx",
      }),
    ).toBeNull();
  });

  it("never adopts an empty host model", () => {
    expect(
      hostModelAdoption({
        hostModel: "",
        lastHostModel: "qwen3.8:27b-mlx",
        sessionModel: "qwen3.8:27b-mlx",
      }),
    ).toBeNull();
  });
});

describe("offlineModelFallback", () => {
  it("keeps the session's model when the Provider's list can't be read", () => {
    expect(
      offlineModelFallback("qwen3.8:27b-mlx", "pierreprudh/lfm2.5-8b-a1b:latest"),
    ).toBe("qwen3.8:27b-mlx");
  });

  it("falls back to the remembered model only for a panel with none", () => {
    expect(offlineModelFallback("", "pierreprudh/lfm2.5-8b-a1b:latest")).toBe(
      "pierreprudh/lfm2.5-8b-a1b:latest",
    );
  });
});

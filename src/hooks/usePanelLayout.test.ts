import { describe, expect, it } from "vitest";
import { canPersistLayout, mergeAiPanels } from "./usePanelLayout";
import type { Layout as PanelLayout } from "../panelLayout";
import type { ProviderId } from "../agent/types";

const HYDRATED: PanelLayout = {
  anchored: true,
  explorer: { x: 0, y: 0, w: 280, h: 600 },
  ai: [
    { id: "ai-main", rect: { x: 700, y: 0, w: 360, h: 600 } },
    { id: "ai-2", rect: { x: 340, y: 20, w: 360, h: 600 } },
  ],
};

// The half-formed layout Focus mode produces: AiPanel's mount-time
// provider/model notification writes an `ai` entry into a layout that was
// never hydrated (Focus never mounts the workbench, so nothing measured it).
const NOT_YET_HYDRATED: PanelLayout = {
  ai: [{ id: "ai-main", rect: { x: 0, y: 0, w: 360, h: 360 } }],
};

describe("canPersistLayout", () => {
  it("persists a layout hydrated from the current workspace", () => {
    expect(canPersistLayout("/repo", "/repo", HYDRATED)).toBe(true);
  });

  it("refuses a layout that was never hydrated (Focus-mode boot)", () => {
    expect(canPersistLayout("/repo", null, NOT_YET_HYDRATED)).toBe(false);
  });

  it("refuses another workspace's layout on a project switch", () => {
    expect(canPersistLayout("/repo-b", "/repo-a", HYDRATED)).toBe(false);
  });

  it("refuses an empty layout", () => {
    expect(canPersistLayout("/repo", "/repo", {})).toBe(false);
  });

  it("refuses when there is no workspace", () => {
    expect(canPersistLayout(null, null, HYDRATED)).toBe(false);
  });
});

const RECT = { x: 0, y: 0, w: 360, h: 600 };

describe("mergeAiPanels", () => {
  it("seeds a panel that has no live pair from storage", () => {
    const merged = mergeAiPanels(
      [{ id: "ai-main", rect: RECT, provider: "openrouter", model: "deepseek/deepseek-v4-flash" }],
      [{ id: "ai-main", rect: RECT }],
      RECT,
    );
    expect(merged[0].provider).toBe("openrouter");
    expect(merged[0].model).toBe("deepseek/deepseek-v4-flash");
  });

  it("keeps the live provider+model when a resync replays an older snapshot", () => {
    // The panel moved to a self-hosted endpoint after the layout was written.
    // A resize re-clamp must not drag it back to the stored pair — that lands
    // an OpenRouter model on a conversation running against the endpoint.
    const merged = mergeAiPanels(
      [{ id: "ai-main", rect: RECT, provider: "openrouter", model: "deepseek/deepseek-v4-flash" }],
      [{
        id: "ai-main",
        rect: RECT,
        provider: "custom:ontraak-prod" as ProviderId,
        model: "qwen3.6:latest",
      }],
      RECT,
    );
    expect(merged[0].provider).toBe("custom:ontraak-prod");
    expect(merged[0].model).toBe("qwen3.6:latest");
  });

  it("carries the worktree pin forward", () => {
    const merged = mergeAiPanels(
      [{ id: "ai-main", rect: RECT }],
      [{ id: "ai-main", rect: RECT, cwd: "/repo-worktrees/feat" }],
      RECT,
    );
    expect(merged[0].cwd).toBe("/repo-worktrees/feat");
  });

  it("takes the rect from storage, since that is what a resync is for", () => {
    const moved = { x: 40, y: 20, w: 500, h: 700 };
    const merged = mergeAiPanels(
      [{ id: "ai-main", rect: moved }],
      [{ id: "ai-main", rect: RECT }],
      RECT,
    );
    expect(merged[0].rect).toEqual(moved);
  });
});

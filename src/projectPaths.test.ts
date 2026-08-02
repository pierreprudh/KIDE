import { describe, expect, it } from "vitest";
import {
  linkedFolderLabel,
  linkedProjectForPath,
  normalizeProjectPath,
  pathBelongsToProject,
} from "./projectPaths";

const KIDE = "/Users/pierre/Documents/Private/KIDE";

describe("project path ownership", () => {
  it("normalizes trailing separators and Windows separators", () => {
    expect(normalizeProjectPath(`${KIDE}///`)).toBe(KIDE);
    expect(normalizeProjectPath("C:\\code\\KIDE\\")).toBe("C:/code/KIDE");
  });

  it("matches exact, nested, and linked-worktree folders", () => {
    expect(pathBelongsToProject(KIDE, KIDE)).toBe(true);
    expect(pathBelongsToProject(`${KIDE}/packages/ui`, KIDE)).toBe(true);
    expect(pathBelongsToProject(`${KIDE}-worktrees/race-one`, KIDE)).toBe(true);
  });

  it("uses path boundaries instead of matching lookalike folders", () => {
    expect(pathBelongsToProject(`${KIDE}-archive`, KIDE)).toBe(false);
    expect(pathBelongsToProject("/Users/pierre/Documents/Private/Other-worktrees/race", KIDE)).toBe(false);
  });

  it("chooses the deepest visible project for nested repositories", () => {
    expect(
      linkedProjectForPath(`${KIDE}/packages/ui/src`, [KIDE, `${KIDE}/packages/ui`]),
    ).toBe(`${KIDE}/packages/ui`);
  });

  it("describes nested folders and worktrees relative to their project", () => {
    expect(linkedFolderLabel(`${KIDE}/packages/ui`, KIDE)).toBe("packages/ui");
    expect(linkedFolderLabel(`${KIDE}-worktrees/race-one`, KIDE)).toBe("Worktree · race-one");
    expect(linkedFolderLabel(KIDE, KIDE)).toBeNull();
  });
});

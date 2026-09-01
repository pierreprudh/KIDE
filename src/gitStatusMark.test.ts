import { describe, expect, it } from "vitest";
import {
  UNNAMED_GIT_STATUS,
  gitStatusLetter,
  gitStatusMark,
  gitStatusMarkForLetter,
} from "./gitStatusMark";

describe("gitStatusLetter", () => {
  it("names the five statuses Klide shows", () => {
    expect(gitStatusLetter("??")).toBe("U");
    expect(gitStatusLetter(" M")).toBe("M");
    expect(gitStatusLetter("MM")).toBe("M");
    expect(gitStatusLetter("A ")).toBe("A");
    expect(gitStatusLetter(" D")).toBe("D");
    expect(gitStatusLetter("R ")).toBe("R");
  });

  it("returns null rather than inventing a letter", () => {
    expect(gitStatusLetter("")).toBeNull();
    expect(gitStatusLetter("  ")).toBeNull();
    expect(gitStatusLetter("!!")).toBeNull();
  });

  it("prefers Modified when a file is both staged and modified", () => {
    // "AM" = added then modified. The working-tree state is what a reader acts
    // on next, and M is the one both surfaces showed before this module.
    expect(gitStatusLetter("AM")).toBe("M");
  });
});

describe("gitStatusMark", () => {
  it("paints a new file the same colour whether or not it is tracked", () => {
    // The drift this module closes: Untracked was --success in the Explorer
    // and --accent in Git Review.
    expect(gitStatusMark("??")?.color).toBe("var(--success)");
    expect(gitStatusMark("A ")?.color).toBe("var(--success)");
  });

  it("carries a word behind every letter", () => {
    expect(gitStatusMark(" M")).toEqual({
      label: "M",
      color: "var(--warning)",
      title: "Modified",
    });
    expect(gitStatusMark(" D")?.title).toBe("Deleted");
    expect(gitStatusMark("R ")?.title).toBe("Renamed");
  });

  it("only ever names a theme token", () => {
    for (const status of ["??", "A ", " M", " D", "R "]) {
      expect(gitStatusMark(status)?.color).toMatch(/^var\(--[a-z-]+\)$/);
    }
    expect(UNNAMED_GIT_STATUS.color).toMatch(/^var\(--[a-z-]+\)$/);
  });

  it("has nothing to show for an unnamed status", () => {
    expect(gitStatusMark("!!")).toBeNull();
    expect(gitStatusMarkForLetter("Z")).toBeNull();
  });
});

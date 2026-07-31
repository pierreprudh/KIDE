import { describe, expect, it } from "vitest";
import { promoteWorkedFolder, rememberOpenedFolder } from "./recentFolders";

const A = "/projects/A";
const B = "/projects/B";
const C = "/projects/C";

describe("recent folder ordering", () => {
  it("does not reorder an existing folder when it is only opened", () => {
    const folders = [A, B, C];
    expect(rememberOpenedFolder(folders, C)).toBe(folders);
  });

  it("adds a newly opened folder at the bottom", () => {
    expect(rememberOpenedFolder([A, B], C)).toEqual([A, B, C]);
  });

  it("keeps a newly opened folder when the list is capped", () => {
    expect(rememberOpenedFolder([A, B, C], "/projects/D", 3)).toEqual([
      A,
      B,
      "/projects/D",
    ]);
  });

  it("promotes a folder only after work starts there", () => {
    expect(promoteWorkedFolder([A, B, C], C)).toEqual([C, A, B]);
  });

  it("does not update state when the worked folder is already first", () => {
    const folders = [A, B, C];
    expect(promoteWorkedFolder(folders, A)).toBe(folders);
  });
});

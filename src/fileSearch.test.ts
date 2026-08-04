import { describe, expect, it } from "vitest";
import { fileMatchRank, isSubsequence, rankFiles } from "./fileSearch";

describe("fileMatchRank", () => {
  it("ranks a named match above a prefix, path prefix, contains, and subsequence", () => {
    const q = "app";
    const ranks = [
      "src/app.ts", // basename is exactly "app"? no — "app.ts"
      "src/appliance.ts",
      "app/thing.ts",
      "src/deep/wrapper.app.ts",
      "src/a-p-p.ts",
    ].map((p) => fileMatchRank(p, q));
    // Every one matches; they must not all land on the same tier.
    expect(ranks.every((r) => r !== null)).toBe(true);
    expect(new Set(ranks).size).toBeGreaterThan(1);
  });

  it("puts an exact basename first", () => {
    // The tier the AI panel's picker was missing entirely.
    expect(fileMatchRank("src/components/App.tsx", "app.tsx")).toBe(0);
    expect(fileMatchRank("src/components/AppShell.tsx", "app.tsx")).not.toBe(0);
  });

  it("is case-insensitive", () => {
    expect(fileMatchRank("src/App.tsx", "APP")).toBe(fileMatchRank("src/app.tsx", "app"));
  });

  it("returns null when nothing matches", () => {
    expect(fileMatchRank("src/app.ts", "zzz")).toBeNull();
  });

  it("treats an empty query as a match on everything", () => {
    expect(fileMatchRank("anything", "")).toBe(0);
    expect(fileMatchRank("anything", "   ")).toBe(0);
  });
});

describe("rankFiles", () => {
  it("orders best-first, unlike one of the two implementations it replaces", () => {
    // The command palette scored 100/80/70/50/20 descending and the AI panel
    // 0/1/2/3 ascending, so the same query gave two different orders.
    const files = ["src/deep/nested/other.ts", "src/router.ts", "src/route.ts", "docs/routing.md"];
    expect(rankFiles(files, "route")[0]).toBe("src/route.ts");
  });

  it("breaks ties on the shallower path", () => {
    // For "app", `src/app.ts` is nearly always the one meant.
    const files = ["src/features/very/deep/app.ts", "src/app.ts"];
    expect(rankFiles(files, "app")).toEqual(["src/app.ts", "src/features/very/deep/app.ts"]);
  });

  it("drops non-matches rather than ranking them last", () => {
    expect(rankFiles(["a.ts", "b.ts"], "zzz")).toEqual([]);
  });

  it("returns the head of the list unranked for an empty query", () => {
    // The caller has already ordered it — recents first, usually.
    const files = ["z.ts", "a.ts", "m.ts"];
    expect(rankFiles(files, "", 2)).toEqual(["z.ts", "a.ts"]);
  });

  it("honours the limit", () => {
    const files = Array.from({ length: 50 }, (_, i) => `src/app${i}.ts`);
    expect(rankFiles(files, "app").length).toBe(8);
    expect(rankFiles(files, "app", 3).length).toBe(3);
  });
});

describe("isSubsequence", () => {
  it("matches characters in order, not necessarily adjacent", () => {
    expect(isSubsequence("mct", "missioncontrol.tsx")).toBe(true);
    expect(isSubsequence("tcm", "missioncontrol.tsx")).toBe(false);
    expect(isSubsequence("", "anything")).toBe(true);
    expect(isSubsequence("abc", "ab")).toBe(false);
  });
});

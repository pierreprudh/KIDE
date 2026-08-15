import { describe, expect, it } from "vitest";
import { keepOrder, providerHistoryExpanded, type OrderMemory } from "./focusHistory";

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

describe("keepOrder", () => {
  const id = (value: string) => value;
  const fresh = (): OrderMemory => new Map();

  it("takes the incoming recency order the first time it sees a list", () => {
    expect(keepOrder(["b", "a", "c"], id, fresh(), "list")).toEqual(["b", "a", "c"]);
  });

  it("holds the order when only the sort key moved", () => {
    // The leapfrog this exists for: two providers running, each message
    // handing first place back to the other.
    const memory = fresh();
    keepOrder(["ollama", "anthropic"], id, memory, "project");
    expect(keepOrder(["anthropic", "ollama"], id, memory, "project")).toEqual([
      "ollama",
      "anthropic",
    ]);
    expect(keepOrder(["ollama", "anthropic"], id, memory, "project")).toEqual([
      "ollama",
      "anthropic",
    ]);
  });

  it("lets a genuine arrival in at the top", () => {
    const memory = fresh();
    keepOrder(["a", "b"], id, memory, "list");
    expect(keepOrder(["new", "a", "b"], id, memory, "list")).toEqual(["new", "a", "b"]);
  });

  it("keeps an arrival where it landed once it is no longer new", () => {
    const memory = fresh();
    keepOrder(["a", "b"], id, memory, "list");
    keepOrder(["new", "a", "b"], id, memory, "list");
    // 'a' bubbling to the top of the incoming sort must not move it now.
    expect(keepOrder(["a", "new", "b"], id, memory, "list")).toEqual(["new", "a", "b"]);
  });

  it("drops what has gone without disturbing the rest", () => {
    const memory = fresh();
    keepOrder(["a", "b", "c"], id, memory, "list");
    expect(keepOrder(["c", "a"], id, memory, "list")).toEqual(["a", "c"]);
  });

  it("keeps each list's order to itself", () => {
    const memory = fresh();
    keepOrder(["a", "b"], id, memory, "one");
    keepOrder(["b", "a"], id, memory, "two");
    expect(keepOrder(["b", "a"], id, memory, "one")).toEqual(["a", "b"]);
    expect(keepOrder(["a", "b"], id, memory, "two")).toEqual(["b", "a"]);
  });

  it("re-resolves from recency once the memory is dropped", () => {
    const memory = fresh();
    keepOrder(["a", "b"], id, memory, "list");
    // A remount starts with an empty memory — coming back to the rail should
    // show the genuinely most recent thing first.
    expect(keepOrder(["b", "a"], id, fresh(), "list")).toEqual(["b", "a"]);
  });
});

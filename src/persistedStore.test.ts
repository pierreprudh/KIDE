import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createPersistedStore, validatedArray } from "./persistedStore";
import { memoryStorage } from "./testStorage";

const KEY = "test.names";
const isName = (value: unknown): value is string => typeof value === "string";

function nameStore(bound?: (names: string[]) => string[]) {
  return createPersistedStore<string[]>({
    key: KEY,
    validate: (parsed) => validatedArray(parsed, isName),
    bound,
  });
}

beforeEach(() => {
  vi.stubGlobal("localStorage", memoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("createPersistedStore", () => {
  it("reads corruption safely: bad JSON, wrong shapes, and bad elements", () => {
    localStorage.setItem(KEY, "{not json");
    expect(nameStore().get()).toEqual([]);

    localStorage.setItem(KEY, JSON.stringify({ nope: true }));
    expect(nameStore().get()).toEqual([]);

    localStorage.setItem(KEY, JSON.stringify(["ada", 7, "grace", null]));
    expect(nameStore().get()).toEqual(["ada", "grace"]);
  });

  it("treats an unavailable localStorage as empty, and mutate still works in memory", () => {
    vi.stubGlobal("localStorage", undefined);
    const store = nameStore();
    expect(store.get()).toEqual([]);
    store.mutate((names) => [...names, "ada"]);
    expect(store.get()).toEqual(["ada"]);
  });

  it("writes through: a mutate is durable for the next reader", () => {
    nameStore().mutate(() => ["ada"]);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(["ada"]);
    // A fresh store instance decodes what the first one persisted.
    expect(nameStore().get()).toEqual(["ada"]);
  });

  it("bounds both the cached and the persisted value", () => {
    const store = nameStore((names) => names.slice(0, 2));
    store.mutate(() => ["ada", "grace", "edsger"]);
    expect(store.get()).toEqual(["ada", "grace"]);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(["ada", "grace"]);
  });

  it("persists the durable form while get() keeps the live one", () => {
    const store = createPersistedStore<string[]>({
      key: KEY,
      validate: (parsed) => validatedArray(parsed, isName),
      persist: (names) => names.map((name) => name.toUpperCase()),
    });
    store.mutate(() => ["ada"]);
    expect(store.get()).toEqual(["ada"]);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(["ADA"]);
  });

  it("notifies on every mutate until unsubscribed; get() serves the new value", () => {
    const store = nameStore();
    const seen: string[][] = [];
    const unsubscribe = store.subscribe(() => seen.push(store.get()));

    store.mutate((names) => [...names, "ada"]);
    store.mutate((names) => [...names, "grace"]);
    expect(seen).toEqual([["ada"], ["ada", "grace"]]);

    unsubscribe();
    store.mutate((names) => [...names, "edsger"]);
    expect(seen).toHaveLength(2);
  });

  it("still notifies subscribers when storage is full", () => {
    const storage = memoryStorage();
    vi.spyOn(storage, "setItem").mockImplementation(() => {
      throw new Error("QuotaExceededError");
    });
    vi.stubGlobal("localStorage", storage);

    const store = nameStore();
    let notified = 0;
    store.subscribe(() => {
      notified += 1;
    });
    store.mutate(() => ["ada"]);
    expect(store.get()).toEqual(["ada"]);
    expect(notified).toBe(1);
  });
});

describe("ledger-metadata rename", () => {
  // Regression: Mission Control used to mirror the metadata blob in useState
  // and pair every setState with a manual write. A rename must be exactly one
  // mutate — one localStorage write, one subscriber notification.
  it("is one mutate: one write, one notification", async () => {
    vi.resetModules();
    const storage = memoryStorage();
    const setItem = vi.spyOn(storage, "setItem");
    vi.stubGlobal("localStorage", storage);

    const { getRunLedgerMetadata, patchRunLedgerMetadata, runLedgerKey, subscribeRunLedgerMetadata } =
      await import("./runLedger");

    let notified = 0;
    subscribeRunLedgerMetadata(() => {
      notified += 1;
    });

    const run = { source: "klide" as const, id: "run_1" };
    patchRunLedgerMetadata(run, (current) => ({ ...current, title: "Renamed", updatedMs: 42 }));

    expect(getRunLedgerMetadata()[runLedgerKey(run)]).toMatchObject({ title: "Renamed", updatedMs: 42 });
    expect(setItem.mock.calls.filter(([key]) => key === "klide.runLedger.metadata")).toHaveLength(1);
    expect(notified).toBe(1);
  });
});

import { describe, expect, it } from "vitest";

import { mayActivateModel } from "./modelActivationPolicy";

describe("resumed model activation policy", () => {
  it("keeps a resumed local transcript passive", () => {
    expect(mayActivateModel({ deferred: true, managedLocal: true })).toBe(false);
  });

  it("allows local activation after the first send", () => {
    expect(mayActivateModel({ deferred: false, managedLocal: true })).toBe(true);
  });

  it("does not gate hosted metadata", () => {
    expect(mayActivateModel({ deferred: true, managedLocal: false })).toBe(true);
  });
});

import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import {
  customIdFromLabel,
  customProviderSync,
  refreshCustomProviders,
  subscribeCustomProviders,
  upsertCustomProvider,
  type CustomProvider,
} from "./customProviders";
import { providerName } from "./agent/providers";

const gateway: CustomProvider = {
  id: "custom:my-gateway",
  label: "My Gateway",
  baseUrl: "https://llm.example.com/v1",
  defaultModel: "devstral-small-2:24b",
};

describe("self-hosted endpoint store", () => {
  beforeEach(() => invokeMock.mockReset());

  it("keeps the id frozen when the display name changes", async () => {
    invokeMock.mockResolvedValue([gateway]);
    await refreshCustomProviders();
    expect(providerName("custom:my-gateway")).toBe("My Gateway");

    // The rename writes the same id back — a fresh id would orphan the
    // endpoint's token and every conversation pinned to it.
    invokeMock.mockReset();
    invokeMock
      .mockResolvedValueOnce(undefined) // custom_provider_upsert
      .mockResolvedValueOnce([{ ...gateway, label: "Datacenter" }]); // list

    await upsertCustomProvider({ ...gateway, label: "Datacenter" });

    expect(invokeMock).toHaveBeenNthCalledWith(1, "custom_provider_upsert", {
      provider: { ...gateway, label: "Datacenter" },
    });
    expect(customProviderSync("custom:my-gateway")?.label).toBe("Datacenter");
    // Everything that renders a provider name reads through this.
    expect(providerName("custom:my-gateway")).toBe("Datacenter");
  });

  it("publishes a rename so open surfaces repaint, and stays quiet otherwise", async () => {
    invokeMock.mockResolvedValue([gateway]);
    await refreshCustomProviders();

    const seen = vi.fn();
    const unsubscribe = subscribeCustomProviders(seen);

    // Same store contents → no notification (the picker re-reads on every open).
    invokeMock.mockResolvedValue([gateway]);
    await refreshCustomProviders();
    expect(seen).not.toHaveBeenCalled();

    invokeMock.mockResolvedValue([{ ...gateway, label: "Datacenter" }]);
    await refreshCustomProviders();
    expect(seen).toHaveBeenCalledTimes(1);

    unsubscribe();
    invokeMock.mockResolvedValue([{ ...gateway, label: "Lab" }]);
    await refreshCustomProviders();
    expect(seen).toHaveBeenCalledTimes(1);
  });

  it("slugifies the name into the id only at creation time", () => {
    expect(customIdFromLabel("My Gateway")).toBe("custom:my-gateway");
    expect(customIdFromLabel("  Lab  #2 ")).toBe("custom:lab-2");
  });
});

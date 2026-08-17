import { beforeEach, describe, expect, it, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({ invokeMock: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

import {
  GATEWAY_DEFAULT_MODEL,
  GATEWAY_PROVIDER_ID,
  connectGateway,
  disconnectGateway,
  isGatewayConnected,
} from "./gateway";
import { providerName } from "./agent/providers";
import { readGatewayStatus, startGateway, stopGateway } from "./ipc/gateway";

describe("provider gateway", () => {
  beforeEach(() => invokeMock.mockReset());

  it("registers as a self-hosted endpoint under a fixed id", async () => {
    invokeMock
      .mockResolvedValueOnce(undefined) // custom_provider_upsert
      .mockResolvedValueOnce([
        {
          id: GATEWAY_PROVIDER_ID,
          label: "opencodex",
          baseUrl: "http://127.0.0.1:10100/v1",
          defaultModel: "anthropic/claude-sonnet-5",
        },
      ]);

    await connectGateway("http://127.0.0.1:10100/v1");

    // The id is fixed, not minted from the label: Settings has to be able to
    // find this row again, and pinned conversations must survive a rename.
    expect(invokeMock).toHaveBeenNthCalledWith(1, "custom_provider_upsert", {
      provider: {
        id: GATEWAY_PROVIDER_ID,
        label: "opencodex",
        baseUrl: "http://127.0.0.1:10100/v1",
        defaultModel: GATEWAY_DEFAULT_MODEL,
      },
    });
    // No token field — a loopback proxy needs no bearer, so the keychain is
    // never touched for it.
    expect(invokeMock.mock.calls[0][1].provider.tokenRef).toBeUndefined();
    expect(isGatewayConnected()).toBe(true);
    expect(providerName(GATEWAY_PROVIDER_ID)).toBe("opencodex");
  });

  it("falls back to the namespaced default when no model is given", async () => {
    invokeMock.mockResolvedValueOnce(undefined).mockResolvedValueOnce([]);

    await connectGateway("http://127.0.0.1:10100/v1", "   ");

    expect(invokeMock.mock.calls[0][1].provider.defaultModel).toBe(
      GATEWAY_DEFAULT_MODEL,
    );
    // provider/model, never a bare id — a bare id falls through to the
    // proxy's own defaultProvider.
    expect(GATEWAY_DEFAULT_MODEL).toContain("/");
  });

  it("disconnecting removes the endpoint and leaves the process alone", async () => {
    invokeMock.mockResolvedValueOnce(undefined).mockResolvedValueOnce([]);

    await disconnectGateway();

    expect(invokeMock).toHaveBeenNthCalledWith(1, "custom_provider_remove", {
      id: GATEWAY_PROVIDER_ID,
    });
    expect(invokeMock.mock.calls.every(([name]) => !String(name).startsWith("gateway_"))).toBe(
      true,
    );
    // The removal refreshes the shared cache itself, so every surface that
    // names providers drops the row without a second round trip.
    expect(isGatewayConnected()).toBe(false);
  });

  it("owns the process-lifecycle wire contract", async () => {
    const status = {
      installed: true,
      running: true,
      managed: true,
      commandPath: "/opt/homebrew/bin/ocx",
      baseUrl: "http://127.0.0.1:10100/v1",
      codexRouted: false,
      detail: "Running on port 10100, started by Klide.",
      warning: null,
    };
    invokeMock.mockResolvedValue(status);

    await expect(readGatewayStatus()).resolves.toEqual(status);
    await startGateway();
    await stopGateway();

    expect(invokeMock.mock.calls.map(([name]) => name)).toEqual([
      "gateway_status",
      "gateway_start",
      "gateway_stop",
    ]);
  });
});

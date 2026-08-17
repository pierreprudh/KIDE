// Typed frontend Adapter for the `gateway_*` command family — the opencodex
// proxy's process lifecycle (installed? running? start, stop).
//
// Only the process lives here. Registering the proxy as a provider Klide can
// chat with goes through the custom-provider store (src/gateway.ts), so there
// stays exactly one writer for ~/.klide/custom_providers.json.

import { invoke } from "@tauri-apps/api/core";

export type GatewayStatus = {
  /** `ocx` resolved on PATH (or via a login shell). */
  installed: boolean;
  /** The proxy answers its health probe on localhost. */
  running: boolean;
  /** Klide owns the process handle — as opposed to having found it running. */
  managed: boolean;
  /** Absolute path of the resolved binary, when installed. */
  commandPath: string | null;
  /** OpenAI-wire base URL, e.g. http://127.0.0.1:10100/v1 */
  baseUrl: string;
  /**
   * The Codex CLI's config currently points at the proxy. Klide un-injects
   * after every start, so this is normally false — true means the injection
   * was re-applied outside Klide.
   */
  codexRouted: boolean;
  /** One human-readable line describing the state above. */
  detail: string;
  /** Set when a start succeeded but a follow-up step didn't. */
  warning: string | null;
};

export function readGatewayStatus(): Promise<GatewayStatus> {
  return invoke<GatewayStatus>("gateway_status");
}

export function startGateway(): Promise<GatewayStatus> {
  return invoke<GatewayStatus>("gateway_start");
}

export function stopGateway(): Promise<GatewayStatus> {
  return invoke<GatewayStatus>("gateway_stop");
}

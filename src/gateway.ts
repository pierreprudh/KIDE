// Provider gateway — the opencodex proxy seen as a Klide provider.
//
// opencodex serves the OpenAI wire (`/v1/chat/completions`, `/v1/models`) in
// front of ~40 upstream providers, so it needs no adapter of its own: it is
// registered as one self-hosted endpoint in the custom-provider store and then
// behaves like any other provider — model picker, Focus, Mission Control, the
// Rust harness with its full tool loop.
//
// Its process lifecycle lives in src/ipc/gateway.ts; this module owns only the
// registration, i.e. what turns "a proxy is running" into "Klide can talk to
// it". The id is fixed rather than minted from a label so Settings can always
// find the gateway's row, and so conversations pinned to it survive a rename.

import {
  customProviderSync,
  removeCustomProvider,
  upsertCustomProvider,
} from "./customProviders";

/** Fixed custom-provider id for the gateway. */
export const GATEWAY_PROVIDER_ID = "custom:opencodex";

/** Label shown in the model picker and anywhere providerName() is rendered. */
export const GATEWAY_LABEL = "opencodex";

/**
 * Model to preselect on connect. opencodex resolves `provider/model` against
 * its own configured providers, so the namespaced form is the unambiguous one
 * — a bare id would fall through to its `defaultProvider`.
 */
export const GATEWAY_DEFAULT_MODEL = "anthropic/claude-sonnet-5";

/** The gateway's dashboard, where accounts and providers are configured. */
export const GATEWAY_DASHBOARD_URL = "http://127.0.0.1:10100";

/** The registered endpoint, or undefined when the gateway isn't connected. */
export function gatewayProvider() {
  return customProviderSync(GATEWAY_PROVIDER_ID);
}

/** Whether the gateway is registered as a provider Klide can chat with. */
export function isGatewayConnected(): boolean {
  return gatewayProvider() !== undefined;
}

/**
 * Register (or update) the gateway as a self-hosted endpoint.
 *
 * No token: opencodex only demands `x-opencodex-api-key` for non-loopback
 * binds, and Klide's custom-provider dispatch already treats the bearer token
 * as optional — so the keychain is never touched for a local gateway.
 */
export async function connectGateway(
  baseUrl: string,
  defaultModel: string = GATEWAY_DEFAULT_MODEL,
): Promise<void> {
  await upsertCustomProvider({
    id: GATEWAY_PROVIDER_ID,
    label: GATEWAY_LABEL,
    baseUrl: baseUrl.trim(),
    defaultModel: defaultModel.trim() || GATEWAY_DEFAULT_MODEL,
  });
}

/** Unregister the gateway. The proxy process is left alone. */
export async function disconnectGateway(): Promise<void> {
  await removeCustomProvider(GATEWAY_PROVIDER_ID);
}

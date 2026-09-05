import type { AgentMode, ProviderId } from "./types";
import { customProviderSync, isCustomProvider } from "../customProviders";
import { customCliSync, getCustomCliSync, isCustomCli } from "../customCli";
import { isDelegateId } from "../delegates";

export type ProviderGroup = {
  label: string;
  items: { id: ProviderId; name: string; available: boolean }[];
};

export type ProviderGroupId = "routed" | "local" | "subscription" | "api";
export type ProviderRuntime =
  | "managed-local"
  | "external-local"
  | "delegate"
  | "hosted"
  | "custom"
  /** Not a Provider that serves models: the Rust router replaces it with a
   *  concrete one at run start. Needs no key, no server, no model list. */
  | "router";

/** One frontend Provider row. Picker grouping, availability, defaults, and
 * runtime capabilities all derive from this catalog so adding a Provider is a
 * one-row change instead of a hunt through parallel maps and predicates. */
export type ProviderDefinition = {
  id: ProviderId;
  name: string;
  /** Name for a dense row, when `name` is deliberately fuller for the picker.
   *  See `providerShortName`. */
  shortName?: string;
  group: ProviderGroupId;
  runtime: ProviderRuntime;
  available: boolean;
  defaultModel: string;
};

export const MLX_MODEL_PRESETS = [
  "mlx-community/Llama-3.1-8B-Instruct-4bit",
  "Qwen/Qwen3-4B-MLX-4bit",
  "mlx-community/gemma-2-9b-it-4bit",
  "mlx-community/gemma-4-E4B-it-qat-4bit",
  "mlx-community/gemma-4-12B-it-qat-4bit",
] as const;

/** Curated Ollama models offered in the picker even before they're pulled.
 *  `pierreprudh/klide-8b` is Klide's own LoRA fine-tune (trained on agent
 *  traces to run this harness's tool/edit contract). Pull it with
 *  `ollama pull pierreprudh/klide-8b` — https://ollama.com/pierreprudh/klide-8b */
export const OLLAMA_MODEL_PRESETS = ["pierreprudh/klide-8b"] as const;

/** Sentinel model for delegate CLIs meaning "no model picked" — the Rust
 *  side (delegate::CLI_DEFAULT_MODEL) omits the model flag when it sees this,
 *  so the CLI opens on whatever default its own settings choose. Forcing a
 *  hardcoded model here made every Claude Code session open on Sonnet. */
export const CLI_DEFAULT_MODEL = "default";

/** The Provider the picker sends for "Auto". The Rust router
 *  (`src-tauri/src/agent/routing.rs`) turns it into a concrete provider +
 *  model at run start — rule out what can't do the job, prefer what you
 *  starred, lock the pick for the conversation — and `RunStarted` then carries
 *  the real pair, so every surface shows what actually ran. Both halves are
 *  the same word because a routed run has no model until Rust gives it one;
 *  the Rust `frontend_auto_sentinel_matches` test keeps the two sides equal. */
export const AUTO_PROVIDER = "auto";
export const AUTO_MODEL = "auto";

export function isAutoProvider(id: string): boolean {
  return id === AUTO_PROVIDER;
}

export const PROVIDER_CATALOG: readonly ProviderDefinition[] = [
  { id: AUTO_PROVIDER, name: "Auto", group: "routed", runtime: "router", available: true, defaultModel: AUTO_MODEL },
  { id: "ollama", name: "Ollama", group: "local", runtime: "managed-local", available: true, defaultModel: "llama3.1:8b" },
  { id: "mlx", name: "MLX (Apple Silicon)", shortName: "MLX", group: "local", runtime: "managed-local", available: true, defaultModel: MLX_MODEL_PRESETS[0] },
  { id: "lmstudio", name: "LM Studio", group: "local", runtime: "external-local", available: true, defaultModel: "local-model" },
  { id: "llamacpp", name: "llama.cpp", group: "local", runtime: "external-local", available: false, defaultModel: "local-model" },
  { id: "vllm", name: "vLLM", group: "local", runtime: "external-local", available: false, defaultModel: "local-model" },
  { id: "claude-code", name: "Claude Code", group: "subscription", runtime: "delegate", available: true, defaultModel: CLI_DEFAULT_MODEL },
  { id: "codex", name: "Codex", group: "subscription", runtime: "delegate", available: true, defaultModel: CLI_DEFAULT_MODEL },
  { id: "opencode", name: "OpenCode", group: "subscription", runtime: "delegate", available: true, defaultModel: CLI_DEFAULT_MODEL },
  { id: "omp", name: "Oh My Pi", group: "subscription", runtime: "delegate", available: true, defaultModel: CLI_DEFAULT_MODEL },
  { id: "anthropic", name: "Anthropic", group: "api", runtime: "hosted", available: true, defaultModel: "claude-sonnet-4-6" },
  { id: "openai", name: "OpenAI", group: "api", runtime: "hosted", available: true, defaultModel: "gpt-4.1" },
  { id: "gemini", name: "Google Gemini", shortName: "Gemini", group: "api", runtime: "hosted", available: false, defaultModel: "gemini-2.5-pro" },
  { id: "mistral", name: "Mistral", group: "api", runtime: "hosted", available: true, defaultModel: "mistral-large-latest" },
  { id: "xai", name: "xAI Grok", shortName: "xAI", group: "api", runtime: "hosted", available: true, defaultModel: "grok-4" },
  { id: "deepseek", name: "DeepSeek", group: "api", runtime: "hosted", available: true, defaultModel: "deepseek-chat" },
  { id: "openrouter", name: "OpenRouter", group: "api", runtime: "hosted", available: true, defaultModel: "openai/gpt-4o" },
] as const;

const GROUPS: Array<{ id: ProviderGroupId; label: string }> = [
  { id: "routed", label: "Routed" },
  { id: "local", label: "Local" },
  { id: "subscription", label: "Subscription" },
  { id: "api", label: "API" },
];

export const PROVIDER_GROUPS: ProviderGroup[] = GROUPS.map((group) => ({
  label: group.label,
  items: PROVIDER_CATALOG
    .filter((provider) => provider.group === group.id)
    .map(({ id, name, available }) => ({ id, name, available })),
}));

export const ALL_PROVIDERS = PROVIDER_CATALOG.map(({ id, name, available }) => ({
  id,
  name,
  available,
}));

export const DEFAULT_MODELS = Object.fromEntries(
  PROVIDER_CATALOG.map((provider) => [provider.id, provider.defaultModel]),
) as Record<ProviderId, string>;

export const MODE_OPTIONS: { id: AgentMode; label: string; title: string }[] = [
  { id: "chat", label: "Chat", title: "Answer without tools." },
  { id: "plan", label: "Plan", title: "Read files and propose a plan." },
  { id: "goal", label: "Goal", title: "Use tools and propose diff-reviewed edits." },
];

export function providerDefinition(id: ProviderId): ProviderDefinition | undefined {
  const builtin = PROVIDER_CATALOG.find((provider) => provider.id === id);
  if (builtin) return builtin;
  if (isCustomProvider(id)) {
    const custom = customProviderSync(id);
    return {
      id,
      name: custom?.label ?? (id.slice("custom:".length) || "Custom"),
      group: "api",
      runtime: "custom",
      available: true,
      defaultModel: custom?.defaultModel ?? "",
    };
  }
  if (isCustomCli(id)) {
    const custom = customCliSync(id);
    return {
      id,
      name: custom?.label ?? (id.slice("cli:".length) || "Custom CLI"),
      group: "subscription",
      runtime: "delegate",
      available: true,
      defaultModel: custom?.defaultModel ?? CLI_DEFAULT_MODEL,
    };
  }
  return undefined;
}

export function isProviderId(id: string): id is ProviderId {
  return (
    PROVIDER_CATALOG.some((provider) => provider.id === id) ||
    isCustomProvider(id) ||
    isCustomCli(id)
  );
}

export function defaultModelForProvider(id: ProviderId): string {
  return providerDefinition(id)?.defaultModel ?? "";
}

export function isManagedLocalProvider(id: ProviderId): boolean {
  return providerDefinition(id)?.runtime === "managed-local";
}

/** Hosted endpoints (and self-hosted ones) authenticate with a key; local
 *  servers and delegate CLIs don't. Pickers use this to decide which rows are
 *  worth probing with `ai_provider_key_status` before offering them. */
export function providerNeedsApiKey(id: ProviderId): boolean {
  const runtime = providerDefinition(id)?.runtime;
  return runtime === "hosted" || runtime === "custom";
}

export function selectableProviders(options: { includeDelegates?: boolean } = {}): ProviderDefinition[] {
  return PROVIDER_CATALOG.filter(
    (provider) =>
      provider.available &&
      (options.includeDelegates !== false || provider.runtime !== "delegate"),
  );
}

export function providerName(id: ProviderId): string {
  return providerDefinition(id)?.name ?? "Unknown Provider";
}

/**
 * The name for a dense row — a board cell, a subtitle — where the picker's
 * fuller name would crowd it out.
 *
 * Falls back to `name`, so only the handful that genuinely differ carry a
 * `shortName`. This exists because Mission Control had grown its own
 * `PROVIDER_LABEL` table that disagreed with the catalog on four ids
 * (`gemini`, `xai`, `mlx`, `omp`) — the board wanting "Gemini" where the picker
 * wants "Google Gemini" is a real requirement, but two hand-kept tables is the
 * wrong way to serve it. `omp` was simply wrong there: the product is Oh My Pi.
 */
/** Is this string one of the catalog's built-in providers? Distinguishes a
 *  known id from a `custom:` slug or a stale one recorded by an older build. */
export function isKnownProvider(id: string): id is ProviderId {
  return PROVIDER_CATALOG.some((p) => p.id === id);
}

export function providerShortName(id: ProviderId): string {
  const def = providerDefinition(id);
  return def?.shortName ?? def?.name ?? "Unknown Provider";
}

/** PROVIDER_GROUPS plus a dynamic "Self-hosted" group built from the
 *  caller-supplied custom providers. Used by the AI panel's provider
 *  dropdown so user-added endpoints appear alongside the built-ins. */
export function providerGroupsWithCustom(
  custom: { id: string; label: string }[],
  customCli: { id: string; label: string }[] = []
): ProviderGroup[] {
  const groups = [...PROVIDER_GROUPS];
  if (customCli.length > 0) {
    groups.splice(2, 0, {
      label: "Custom CLIs",
      items: customCli.map((c) => ({
        id: c.id as ProviderId,
        name: c.label,
        available: true,
      })),
    });
  }
  if (custom.length > 0) {
    groups.push({
      label: "Self-hosted",
      items: custom.map((c) => ({
        id: c.id as ProviderId,
        name: c.label,
        available: true,
      })),
    });
  }
  return groups;
}

export function isDelegateProvider(id: ProviderId): boolean {
  return providerDefinition(id)?.runtime === "delegate" || isDelegateId(id);
}

/**
 * The reverse of `providerName`, for delegate CLIs only.
 *
 * A stored assistant turn records the CLI that produced it as a *display name*
 * (`Msg.delegateProvider`, written as `providerName(turn.provider)`), which is
 * the only surviving evidence of a thread's origin once its metadata has been
 * overwritten. This maps that name back to an id so the heal in
 * `conversationOriginHeal.ts` can restore it.
 *
 * Built-ins plus whatever custom CLIs the sync store already holds; `null`
 * when no delegate in this build answers to that name (a renamed custom CLI,
 * or a store not yet loaded — the caller must leave such a record alone rather
 * than guess).
 */
export function delegateProviderByName(name: string): ProviderId | null {
  const wanted = name.trim().toLowerCase();
  if (!wanted) return null;
  const builtin = PROVIDER_CATALOG.find(
    (provider) =>
      provider.runtime === "delegate" &&
      (provider.name.toLowerCase() === wanted ||
        provider.shortName?.toLowerCase() === wanted ||
        provider.id.toLowerCase() === wanted),
  );
  if (builtin) return builtin.id;
  const custom = getCustomCliSync().find((cli) => cli.label.trim().toLowerCase() === wanted);
  return custom ? (custom.id as ProviderId) : null;
}

export function normalizeAgentMode(value: string | null): AgentMode {
  if (value === "build" || value === "goal") return "goal";
  if (value === "plan") return "plan";
  return "chat";
}

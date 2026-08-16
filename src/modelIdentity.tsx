import type { ReactElement } from "react";
import { modelBrand } from "./modelBrand";
import { BrandImage, ProviderLogo, TwoToneMark } from "./components/ai/icons";

type LogoProps = { size?: number };
type LogoComponent = (props: LogoProps) => ReactElement;

export type ModelIdentity = {
  name: string;
  Logo: LogoComponent;
};

function MiniMaxLogo({ size = 14 }: LogoProps) {
  return <BrandImage src="/minimax-logo.png" size={size} />;
}

function KimiLogo({ size = 14 }: LogoProps) {
  return <TwoToneMark light="/kimi-logo-light.svg" dark="/kimi-logo-dark.svg" size={size} />;
}

function ZaiLogo({ size = 14 }: LogoProps) {
  return <BrandImage className="white-logo-img" src="/zai-logo.png" size={size} />;
}

function AnthropicLogo({ size = 14 }: LogoProps) {
  return <ProviderLogo id="anthropic" size={size} />;
}

function CodexLogo({ size = 14 }: LogoProps) {
  return <ProviderLogo id="codex" size={size} />;
}

function OpenAiLogo({ size = 14 }: LogoProps) {
  return <ProviderLogo id="openai" size={size} />;
}

function GoogleLogo({ size = 14 }: LogoProps) {
  return <ProviderLogo id="gemini" size={size} />;
}

function XaiLogo({ size = 14 }: LogoProps) {
  return <ProviderLogo id="xai" size={size} />;
}

const MODEL_IDENTITY_RULES: { pattern: RegExp; identity: ModelIdentity }[] = [
  { pattern: /minimax/i, identity: { name: "MiniMax", Logo: MiniMaxLogo } },
  { pattern: /kimi|moonshot/i, identity: { name: "Kimi", Logo: KimiLogo } },
  { pattern: /claude|sonnet|opus|haiku/i, identity: { name: "Anthropic", Logo: AnthropicLogo } },
  { pattern: /codex/i, identity: { name: "Codex", Logo: CodexLogo } },
  {
    pattern: /(?:^|\/)gpt-|(?:^|\/)o[134](?:\b|-)/i,
    identity: { name: "OpenAI", Logo: OpenAiLogo },
  },
  { pattern: /glm|z-?ai/i, identity: { name: "Z.AI", Logo: ZaiLogo } },
  { pattern: /gemini|gemma/i, identity: { name: "Google", Logo: GoogleLogo } },
  { pattern: /grok/i, identity: { name: "xAI", Logo: XaiLogo } },
];

const NON_MODEL_LABEL = /^(auto|default|none|null|unknown)$/i;

/**
 * Resolve only identities that can be inferred confidently from the saved
 * model id. This deliberately has no provider/runtime fallback: an unknown
 * Ollama, MLX, OpenRouter, or custom model should remain visually unbranded.
 */
export function modelIdentity(model: string | null | undefined): ModelIdentity | null {
  const normalized = model?.trim();
  if (!normalized || NON_MODEL_LABEL.test(normalized)) return null;

  const brand = modelBrand(normalized);
  if (brand) return { name: brand.name, Logo: brand.Logo };

  return MODEL_IDENTITY_RULES.find(({ pattern }) => pattern.test(normalized))?.identity ?? null;
}

/** On-device families with no maker mark of their own. They still ran locally,
 *  so the local-runtime glyph is the honest answer — better than the generic
 *  fallback, which reads as "unknown model". */
const LOCAL_FAMILY_WITHOUT_MARK = /phi-?\d|nomic|mxbai|granite|smollm|starcoder/i;

export function resolveModelLogo(
  model: string | null | undefined,
  size = 14,
): ReactElement | null {
  const identity = modelIdentity(model);
  if (identity) {
    const Logo = identity.Logo;
    return <Logo size={size} />;
  }
  // Mission Control used to add this arm in a local function *also* called
  // `resolveModelLogo`, importing this one aliased as `resolveKnownModelLogo` to
  // make room — two names for one concept in one file. The arm belongs here,
  // with the rest of model → mark.
  if (model && LOCAL_FAMILY_WITHOUT_MARK.test(model)) {
    return <ProviderLogo id="ollama" size={size} />;
  }
  return null;
}

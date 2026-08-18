import type { CSSProperties, ReactElement } from "react";
import { modelBrand } from "./modelBrand";
import { BrandImage, ProviderLogo, TwoToneMark } from "./components/ai/icons";
import type { ProviderId } from "./agent/types";

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

/* ─────────────────────── provider + model, as one mark ───────────────────── */

/** The pair splits one slot between two marks, so below this neither half is
 *  legible and the provider stands alone — which is also the right answer for
 *  the 16px source-filter marks, where the row is *about* the runner and a
 *  maker would be noise. */
const PAIR_MIN_SIZE = 22;

/** The maker's share of the box; the rest goes to the runner. */
const MAKER_SHARE = 0.46;

/** How much of the maker rides *over* the runner's corner. Corner-to-corner the
 *  two boxes would only touch at a point, and every mark keeps padding inside
 *  its own box, so a pair that merely abuts reads as two strays with a hole
 *  between them. The maker tucks into the runner instead — and nothing is drawn
 *  around it to make the tuck work: no disc, no ring, no tile. */
const OVERLAP = 0.35;

/**
 * A conversation's runner and its model drawn as one mark.
 *
 * "An OpenCode conversation" and "…on Kimi" are two different facts, and every
 * surface that shows one of these used to pick a side and drop the other:
 * Focus's resume cards showed only the CLI, Mission Control's conversation
 * avatar only the model. So the same run read differently depending on where
 * you looked at it — and for a delegate whose whole catalogue is other makers'
 * models, the CLI-only answer says nothing about what actually replied.
 *
 * The runner leads from the top-left and the maker tucks over its bottom-right
 * corner, bare — a disc-and-hairline cut-out under the small mark would read as
 * the chrome this app doesn't wear, so the overlap carries itself.
 *
 * `size` is the *total* footprint, so a caller's geometry is the same whether
 * the model names a maker or not — an unbranded model simply leaves the
 * provider mark alone, which is still the honest answer.
 */
export function ProviderModelMark({
  provider,
  model,
  size = 24,
}: {
  provider: ProviderId;
  model?: string | null;
  size?: number;
}): ReactElement {
  const makerSize = Math.round(size * MAKER_SHARE);
  const maker = resolveModelLogo(model, makerSize);
  if (size < PAIR_MIN_SIZE || !maker) return <ProviderLogo id={provider} size={size} />;

  const runnerSize = size - makerSize + Math.round(makerSize * OVERLAP);
  const corner: CSSProperties = { position: "absolute", display: "grid", placeItems: "center" };
  return (
    <span
      style={{
        position: "relative",
        display: "inline-block",
        width: size,
        height: size,
        flexShrink: 0,
      }}
    >
      <span style={{ ...corner, top: 0, left: 0, width: runnerSize, height: runnerSize }}>
        <ProviderLogo id={provider} size={runnerSize} />
      </span>
      <span style={{ ...corner, right: 0, bottom: 0, width: makerSize, height: makerSize }}>
        {maker}
      </span>
    </span>
  );
}

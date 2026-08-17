// The one fold of the Agent event stream. `createFold` turns `AgentEvent`s
// into normalized conversation rows and runs at two paces over the same code:
// the AI panel's live run feeds it one event at a time (through the turn
// driver in `components/ai/turnDriver.ts`), and replay drains a whole
// transcript through `foldAgentEvents`. Both renderers sit on the same rows —
// each has its own row shape (Msg vs RunMessage), so the fold owns the pairing
// logic (user↔assistant, tool-call lifecycle by toolCallId, streamed deltas)
// and the mappers do the trivial shape conversion. The wire format lives once,
// in here — everything downstream is a projection of this fold, never a
// second parse of the events.

import type {
  AgentAttachment,
  AgentContentBlock,
  AgentEvent,
  AgentTurnTiming,
  AgentUsage,
} from "./types";
import type { Msg } from "../components/ai/types";
import type { RunMessage, RunToolCall } from "../runs";
import { estimateTokens } from "../components/ai/utils";

export type FoldedToolCall = {
  id: string;
  name: string;
  input: unknown;
  summary?: string;
  result?: { content: string; ok: boolean };
  status: "started" | "finished" | "unknown";
  /** Set when a *delegate CLI* ran this itself (its provider id, e.g.
   *  `claude-code`) rather than Klide dispatching it. Klude applied no
   *  capability, no permission prompt and no diff review to these, so every
   *  surface that renders or counts tool work must be able to tell them apart —
   *  that is the whole reason this field exists rather than a silent reuse of
   *  the dispatched-call shape. */
  observedBy?: string;
};

/** Per-message footer metrics. One type for both paces — a turn must read the
 *  same after a reload as it did live. */
export type AssistantMeta = {
  /** Wall-clock duration from the previous turn boundary (user or tool).
   *  Includes tool execution and diff-review waiting — see `modelMs` for the
   *  provider's own share of it. Replay derives it from event timestamps; the
   *  live path measures it and passes it in via `FoldLiveTiming`. */
  ms?: number;
  /** Provider request → response, ms, as measured in the harness. Absent on
   *  harness-authored messages and on transcripts written before the harness
   *  recorded turn timing. */
  modelMs?: number;
  /** Provider request → first streamed token, ms. */
  ttftMs?: number;
  /** Completion tokens — exact from `AgentUsage` when present, else a
   *  length-based estimate. The mapper decides whether to expose this. */
  tokens?: number;
  tokensEstimate?: number;
  /** Provider-reported prompt tokens, when the usage block carried them. */
  promptTokens?: number;
  /** Decode speed in tok/s — never derived from wall clock (see computeMeta). */
  tps?: number;
  /** True iff `tokens` came from the provider, not the estimate. */
  exact?: boolean;
  /** Per-turn cost in USD — provider-reported when present, else estimated
   *  from `FoldOptions.pricing`. Absent for local / subscription turns. */
  costUsd?: number;
};

export type FoldedRow =
  | {
      kind: "user";
      text: string;
      attachments?: AgentAttachment[];
      /** The `user_message` event's `ts`, epoch ms. */
      ts?: number;
    }
  | {
      kind: "assistant";
      text: string;
      thinking?: string;
      toolCalls: FoldedToolCall[];
      meta?: AssistantMeta;
      /** The `assistant_message` event's `ts`, epoch ms. */
      ts?: number;
    }
  | {
      kind: "compaction";
      summary: string;
      /** Conversation rows that preceded the marker — i.e. what the model
       *  stopped seeing verbatim from this point on. Derived here rather than
       *  carried on the wire, which has no count. */
      count: number;
    }
  | {
      kind: "steering";
      reason: string;
    };

type AssistantRow = Extract<FoldedRow, { kind: "assistant" }>;

export type FoldPricing = { inputPerMillion: number; outputPerMillion: number } | null;

/** Live-path measurements the fold cannot know from the events alone: the
 *  panel's wall-clock turn duration and its own first-delta TTFT fallback
 *  (for turns the harness recorded no timing for). Purely presentational —
 *  neither may feed the tok/s rule. */
export type FoldLiveTiming = {
  turnMs?: number;
  ttftFallbackMs?: number;
};

/** What one `apply` did: which row indices were created or mutated, and — when
 *  the event closed an assistant turn — that turn's meta. */
export type FoldStep = {
  changed: number[];
  finalizedMeta?: AssistantMeta;
};

export type FoldOptions = {
  /** Per-token list prices for cost estimation when the provider reports no
   *  cost of its own. The replay path passes none: a transcript either carried
   *  the provider's own figure or shows no cost. */
  pricing?: FoldPricing;
  /** Start the fold with one open (still-streaming) empty assistant row. The
   *  live path uses this to adopt the placeholder bubble the panel inserts
   *  before the run's first event arrives. */
  seedOpenAssistant?: boolean;
};

export type FoldHandle = {
  /** Feed one event. Cheap enough for per-token deltas: a delta is a string
   *  append on the open row. Returns which rows it touched. */
  apply(event: AgentEvent, live?: FoldLiveTiming): FoldStep;
  /** The current rows. The array and its row objects are mutated in place by
   *  `apply`; project them (see `foldedRowToMsgs`) before handing to React. */
  rows(): FoldedRow[];
};

export function createFold(opts: FoldOptions = {}): FoldHandle {
  const rows: FoldedRow[] = [];
  const pricing = opts.pricing ?? null;
  let turnStartTs: number | undefined;
  // The still-streaming assistant row deltas accumulate into. Closed by the
  // turn's `assistant_message`, and by any event that means "the next text
  // belongs below me" (tool card, steering marker, user turn) — mirroring how
  // the live view splits a turn's text around its tool cards.
  let open: { row: AssistantRow; idx: number } | null = null;

  if (opts.seedOpenAssistant) {
    const seeded: AssistantRow = { kind: "assistant", text: "", toolCalls: [] };
    rows.push(seeded);
    open = { row: seeded, idx: 0 };
  }

  const lastAssistant = (): { row: AssistantRow; idx: number } | null => {
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i];
      if (row.kind === "assistant") return { row, idx: i };
    }
    return null;
  };

  // Walk every assistant row, most-recent first. A tool call can be attached
  // to a non-final assistant (e.g. streamed tool calls interleaved with
  // follow-up text), so we don't just look at the last row.
  const findTool = (
    toolCallId: string,
  ): { call: FoldedToolCall; idx: number } | null => {
    for (let i = rows.length - 1; i >= 0; i--) {
      const row = rows[i];
      if (row.kind !== "assistant") continue;
      const found = row.toolCalls.find((t) => t.id === toolCallId);
      if (found) return { call: found, idx: i };
    }
    return null;
  };

  const upsertTool = (
    toolCallId: string,
    patch: (t: FoldedToolCall) => void,
  ): number => {
    const existing = findTool(toolCallId);
    if (existing) {
      patch(existing.call);
      return existing.idx;
    }
    let host = lastAssistant();
    if (!host) {
      const created: AssistantRow = { kind: "assistant", text: "", toolCalls: [] };
      rows.push(created);
      host = { row: created, idx: rows.length - 1 };
    }
    const created: FoldedToolCall = {
      id: toolCallId,
      name: "tool",
      input: undefined,
      status: "unknown",
    };
    host.row.toolCalls.push(created);
    patch(created);
    return host.idx;
  };

  const apply = (event: AgentEvent, live?: FoldLiveTiming): FoldStep => {
    if (event.type === "user_message") {
      turnStartTs = event.ts;
      open = null;
      rows.push({
        kind: "user",
        text: event.text,
        attachments: event.attachments?.length ? event.attachments : undefined,
        ts: event.ts,
      });
      return { changed: [rows.length - 1] };
    }

    if (event.type === "assistant_delta") {
      if (!open) {
        const created: AssistantRow = { kind: "assistant", text: "", toolCalls: [] };
        rows.push(created);
        open = { row: created, idx: rows.length - 1 };
      }
      open.row.text += event.text;
      if (event.thinking) open.row.thinking = (open.row.thinking ?? "") + event.thinking;
      return { changed: [open.idx] };
    }

    if (event.type === "assistant_message") {
      const text = extractAssistantText(event.content);
      const eventThinking = event.content
        .filter(isThinkingBlock)
        .map((b) => b.text)
        .join("")
        .trim();
      const toolBlocks = event.content.filter(isToolCallBlock);

      const ms =
        live?.turnMs ??
        (turnStartTs !== undefined && event.ts >= turnStartTs
          ? event.ts - turnStartTs
          : undefined);
      turnStartTs = event.ts;

      // Finalize the streaming row when one is open, else start a fresh one —
      // each `assistant_message` is one turn, live and on replay alike.
      let target: { row: AssistantRow; idx: number };
      if (open) {
        target = open;
        open = null;
      } else {
        const created: AssistantRow = { kind: "assistant", text: "", toolCalls: [] };
        rows.push(created);
        target = { row: created, idx: rows.length - 1 };
      }
      const { row, idx } = target;
      // Empty final text with streamed deltas → keep the streamed content.
      row.text = text || row.text;
      row.thinking = eventThinking || row.thinking || undefined;
      for (const b of toolBlocks) {
        if (row.toolCalls.some((t) => t.id === b.toolCallId)) continue;
        row.toolCalls.push({
          id: b.toolCallId,
          name: b.name,
          input: b.input,
          status: "unknown",
        });
      }
      const meta = computeMeta(row.text, row.thinking, ms, event.usage, event.timing, {
        ttftFallbackMs: live?.ttftFallbackMs,
        pricing,
      });
      row.meta = meta ?? undefined;
      row.ts = event.ts;
      return { changed: [idx], finalizedMeta: meta ?? undefined };
    }

    if (event.type === "tool_call_started") {
      const idx = upsertTool(event.toolCallId, (t) => {
        t.name = event.name;
        t.input = event.input;
        t.summary = event.summary;
        t.status = "started";
      });
      // A tool card sits below the turn's text; whatever streams next belongs
      // in a new bubble under the card, not merged above it.
      open = null;
      return { changed: [idx] };
    }

    if (event.type === "tool_call_finished") {
      const idx = upsertTool(event.toolCallId, (t) => {
        t.result = { content: event.result.content, ok: event.result.ok };
        t.status = "finished";
      });
      return { changed: [idx] };
    }

    // Work a delegate CLI did on its own. Same row shape as a dispatched call
    // so the conversation reads consistently, tagged with who ran it so nothing
    // downstream can claim Klide gated it.
    if (event.type === "observed_tool_call") {
      const idx = upsertTool(event.toolCallId, (t) => {
        t.name = event.name;
        t.input = event.input;
        t.summary = event.summary;
        t.status = "started";
        t.observedBy = event.provider;
      });
      open = null;
      return { changed: [idx] };
    }

    if (event.type === "observed_tool_result") {
      const idx = upsertTool(event.toolCallId, (t) => {
        t.result = { content: event.content, ok: event.ok };
        t.status = "finished";
      });
      return { changed: [idx] };
    }

    if (event.type === "context_compacted") {
      // The auto-compactor collapsed the older turns for the *model*. The
      // transcript still holds them all, so replay renders everything — but it
      // has to render the marker too, or a reloaded conversation looks like an
      // unbroken thread that mysteriously forgot its early turns.
      rows.push({
        kind: "compaction",
        summary: event.summary,
        count: rows.length,
      });
      return { changed: [rows.length - 1] };
    }

    if (event.type === "steering_injected") {
      open = null;
      rows.push({ kind: "steering", reason: event.reason });
      return { changed: [rows.length - 1] };
    }

    return { changed: [] };
  };

  return { apply, rows: () => rows };
}

/** Replay pace: drain a whole transcript through the same fold. */
export function foldAgentEvents(events: AgentEvent[]): FoldedRow[] {
  const fold = createFold();
  for (const event of events) fold.apply(event);
  return fold.rows();
}

/** The one "text of an assistant message" rule: concatenated text blocks.
 *  Shared by the fold, AiPanel's subagent/advisor report accumulation, and
 *  the advisor consult — they must agree on what the model "said". */
export function extractAssistantText(content: AgentContentBlock[]): string {
  return content.filter(isTextBlock).map((b) => b.text).join("");
}

function computeMeta(
  text: string,
  thinking: string | undefined,
  ms: number | undefined,
  usage: AgentUsage | undefined,
  timing: AgentTurnTiming | undefined,
  extra: { ttftFallbackMs?: number; pricing: FoldPricing },
): AssistantMeta | null {
  const hasUsage = usage?.completionTokens !== undefined;
  const estimated = estimateTokens(text) + estimateTokens(thinking ?? "");
  const tokens = hasUsage ? usage!.completionTokens! : estimated;
  // Decode window, best source first: the provider's own eval duration, then
  // the harness-measured provider time minus TTFT. Wall clock is never used —
  // it includes every tool call and diff-review pause of the turn, so a
  // wall-clock tok/s is a lie both live and on replay.
  const decodeMs =
    usage?.evalDurationMs !== undefined && usage.evalDurationMs > 0
      ? usage.evalDurationMs
      : timing !== undefined
        ? timing.modelMs - (timing.ttftMs ?? 0)
        : undefined;
  const tps =
    tokens > 0 && decodeMs !== undefined && decodeMs > 100
      ? Math.round(tokens / (decodeMs / 1000))
      : undefined;
  if (ms === undefined && !tokens && tps === undefined && timing === undefined) return null;
  // Per-turn cost: the provider's own figure wins (OpenRouter reports the real
  // charged amount); otherwise token counts × list price when the caller
  // supplied pricing. Local / subscription turns leave costUsd undefined.
  const costUsd =
    usage?.costUsd !== undefined
      ? usage.costUsd
      : extra.pricing && usage?.promptTokens !== undefined && usage?.completionTokens !== undefined
        ? (usage.promptTokens * extra.pricing.inputPerMillion +
            usage.completionTokens * extra.pricing.outputPerMillion) /
          1_000_000
        : undefined;
  return {
    ms,
    modelMs: timing?.modelMs,
    ttftMs: timing?.ttftMs ?? extra.ttftFallbackMs,
    tokens: tokens || undefined,
    tokensEstimate: hasUsage ? undefined : estimated || undefined,
    promptTokens: usage?.promptTokens,
    tps,
    exact: hasUsage,
    costUsd,
  };
}

function isTextBlock(
  b: AgentContentBlock,
): b is { type: "text"; text: string } {
  return b.type === "text";
}
function isThinkingBlock(
  b: AgentContentBlock,
): b is { type: "thinking"; text: string } {
  return b.type === "thinking";
}
function isToolCallBlock(
  b: AgentContentBlock,
): b is {
  type: "tool_call";
  toolCallId: string;
  name: string;
  input: unknown;
} {
  return b.type === "tool_call";
}

// ── Mappers ──────────────────────────────────────────────────────────────
// Each consumer picks the field it cares about. The AI panel keeps separate
// `role: "tool"` rows for tool results (so the renderer can show the call
// info and the result on distinct rows). Mission Control folds tool calls
// into the assistant's `tools` field with full lifecycle.

/** Presentation options for the Msg projection. Replay passes none; the live
 *  view tags rows with its delegate flags and shows "Running…" placeholders
 *  for calls that have started but not finished. */
export type FoldedMsgView = {
  delegate?: { delegateConsole?: boolean; delegateProvider?: string };
  runningPlaceholders?: boolean;
};

/** The one compaction-marker Msg. Shared by the replay mapper below and the
 *  live `context_compacted` handler in AiPanel — the marker must read the
 *  same in both; only `count` differs by what each side could see. */
export function compactionMsg(count: number, summary: string): Msg {
  return {
    role: "system",
    // Plain-text fallback for serialization and search.
    content: `Compacted ${count} earlier message${count === 1 ? "" : "s"} to free context.`,
    // "agent" layout (the slim tool-style row): the wire event carries no
    // manual/automatic distinction, and the unobtrusive row is the safe
    // default for a harness-emitted marker.
    compaction: { count, summary, source: "agent" },
  };
}

/** Project one row into the AI panel's Msg shape. Rows are independent, so
 *  the live path can re-project only the rows an event touched and keep every
 *  other Msg reference stable across renders. */
export function foldedRowToMsgs(row: FoldedRow, view: FoldedMsgView = {}): Msg[] {
  if (row.kind === "user") {
    return [
      {
        role: "user",
        content: row.text,
        attachments: row.attachments,
        ts: row.ts,
      },
    ];
  }
  if (row.kind === "compaction") {
    return [compactionMsg(row.count, row.summary)];
  }
  if (row.kind === "steering") {
    return [
      {
        role: "system",
        content: row.reason,
        steering: { reason: row.reason },
      },
    ];
  }
  const msgs: Msg[] = [
    {
      role: "assistant",
      content: row.text,
      thinking: row.thinking,
      toolCalls: row.toolCalls.length
        ? row.toolCalls.map((t) => ({
            id: t.id,
            name: t.name,
            // The raw input object, not a JSON string — the renderer's
            // structured rows (spawn_subagent, path summaries) read fields
            // off it, and the memory summarizer extracts file paths from it.
            args: t.input,
          }))
        : undefined,
      meta: row.meta
        ? {
            ms: row.meta.ms,
            modelMs: row.meta.modelMs,
            ttftMs: row.meta.ttftMs,
            tokens: row.meta.tokens,
            promptTokens: row.meta.promptTokens,
            tps: row.meta.tps,
            exact: row.meta.exact,
            costUsd: row.meta.costUsd,
          }
        : undefined,
      ts: row.ts,
      ...view.delegate,
    },
  ];
  for (const t of row.toolCalls) {
    if (t.result) {
      msgs.push({
        role: "tool",
        content: t.result.content,
        toolName: t.name,
        toolCallId: t.id,
        observedBy: t.observedBy,
      });
    } else if (view.runningPlaceholders && t.status === "started") {
      msgs.push({
        role: "tool",
        // Same "Running …" convention for both, so the row renders as pending
        // either way. For an observed call it names the delegate's own step.
        content: `Running ${t.observedBy ? (t.summary ?? t.name) : t.name}...`,
        toolName: t.name,
        toolCallId: t.id,
        observedBy: t.observedBy,
      });
    }
  }
  return msgs;
}

export function foldedToMsgs(rows: FoldedRow[]): Msg[] {
  return rows.flatMap((row) => foldedRowToMsgs(row));
}

export function foldedToRunMessages(rows: FoldedRow[]): RunMessage[] {
  const out: RunMessage[] = [];
  for (const row of rows) {
    if (row.kind === "user") {
      out.push({ role: "user", text: row.text });
      continue;
    }
    // `RunMessage.role` is "user" | "assistant" by wire contract (the Rust
    // struct and every Delegate adapter agree), so AI-panel transcript
    // annotations have no row to occupy in Mission Control.
    if (row.kind === "compaction" || row.kind === "steering") continue;
    if (!row.text.trim() && row.toolCalls.length === 0) continue;
    out.push({
      role: "assistant",
      text: row.text,
      tools: row.toolCalls.length
        ? row.toolCalls.map(toRunToolCall)
        : undefined,
    });
  }
  return out;
}

function toRunToolCall(t: FoldedToolCall): RunToolCall {
  return {
    id: t.id,
    name: t.name,
    input: t.input,
    summary: t.summary,
    result: t.result?.content,
    ok: t.result?.ok,
    status: t.status,
  };
}

/**
 * The streaming chat-adapter contract — the core of the provider runtime.
 *
 * Each adapter (Anthropic, OpenAI/ZAI/DeepSeek, Gemini, …) translates the
 * normalized `AgentMessage` / `ToolSpec` format to its vendor schema and back.
 * Historically defined in `@mcp/code-agent/providers/adapter.ts`; moved here so
 * the SDK owns the contract. The old module re-exports these names.
 */
import type { AgentMessage, ChatDelta, JsonSchema } from './wire.js';

/**
 * One physical upstream HTTP/stream attempt.
 *
 * Providers report this independently from the successful turn telemetry so
 * retries and failed requests remain visible instead of disappearing behind
 * the final successful response.
 */
export interface ProviderAttemptTelemetry {
  status: number | null;
  ok: boolean;
  generationId?: string | null;
  requestId?: string | null;
  upstreamProvider?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
  cachedTokens?: number | null;
  costUsd?: number | null;
  retryAfter?: string | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  durationMs: number;
}

export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export interface ChatRequest {
  system: string;
  messages: AgentMessage[];
  tools: ToolSpec[];
  signal?: AbortSignal;
  /** Enable thinking/reasoning mode (Gemini thinkingConfig, Anthropic extended thinking, Codex reasoning.effort). */
  thinking?: boolean;
  /**
   * Explicit reasoning-effort level (e.g. `minimal`/`low`/`medium`/`high`/`xhigh`).
   * Orthogonal to `thinking`: when set, providers that expose discrete effort
   * levels (Codex via `reasoning.effort`, OpenRouter via `reasoning.effort`)
   * MUST use this value directly instead of deriving effort from `thinking`.
   * Validated against the model's `supported_reasoning_levels` upstream — the
   * provider only checks membership against its own capability list. Undefined
   * → provider falls back to the `thinking`-derived behaviour / model default.
   */
  reasoningEffort?: string | null;
  /**
   * Per-request thinking budget (in tokens). Only honoured by providers
   * whose extended-thinking surface accepts a budget (Anthropic). Other
   * providers ignore it silently. When undefined the provider's
   * `defaultThinking.budget_tokens` applies.
   */
  thinkingBudgetTokens?: number;
  /**
   * For stateful providers (ChatGPT/Codex with `store: true`): identifier of
   * the prior response. When present, the provider sends only the message
   * delta and lets the backend reconstruct the prefix from the stored response.
   */
  previousResponseId?: string;
  /**
   * Companion to `previousResponseId`: how many messages were already on the
   * server side. The provider ships `messages.slice(previousResponseMessageCount)`.
   */
  previousResponseMessageCount?: number;
  /** Stable local session id, used by providers that expose prompt/cache affinity knobs. */
  sessionId?: string;
  /**
   * Best-effort audit hook fired once for every physical upstream attempt.
   * Telemetry failures must never fail the model request.
   */
  onAttempt?: (attempt: ProviderAttemptTelemetry) => void | Promise<void>;
  /** Real incoming response bytes, including keepalives swallowed by an SDK.
   * Per request and payload-free. Never call from a local timer or UI heartbeat.
   */
  onTransportActivity?: () => void;
  /**
   * Sampling parameters resolved by the runner via `resolveTemperature()`.
   * Each provider reads `inference.temperature` and translates it to its
   * vendor schema (or omits it when the model rejects sampling — e.g. OpenAI
   * o-series, Anthropic with extended thinking). Range [0, 1] enforced by the
   * resolver; providers do not re-clamp.
   */
  inference?: {
    temperature?: number;
  };
}

/**
 * A provider-agnostic streaming chat interface with tool-calling.
 */
export interface ChatProvider {
  /** Same capabilities used by the final wire guard, exposed for truthful UI/policy. */
  readonly reasoningCapabilities?: import('./reasoning.js').NativeReasoningCapability;
  /** Verified by the adapter/transport. Absent means unknown, not unlimited. */
  readonly toolLimits?: { maxCount?: number; maxSchemaBytes?: number; maxNameChars?: number; source: string };
  readonly name: string;
  /** Active model. May be reassigned mid-session via setModel(). */
  model: string;
  setModel(model: string): void;
  chat(req: ChatRequest): AsyncIterable<ChatDelta>;
}

/**
 * Stream consumer — pure accumulator over `AsyncIterable<ChatDelta>`.
 *
 * The provider emits a flat stream of delta events (text chunks, tool-use
 * boundaries, usage, done). This function buckets them into the structured
 * shape the Executing node needs: text blocks, tool_use blocks (with their
 * final input objects), usage, stop reason.
 *
 * Side effects are limited to the optional `onTextDelta` / `onThinkingDelta` /
 * `onToolCallStart` callbacks — used by the runner to stream live progress
 * to the dashboard/CLI without coupling stream consumption to event
 * emission.
 *
 * Does NOT mutate any caller state.
 */
import type {
  AssistantMessagePhase,
  ChatDelta,
  ChatUsage,
  ChatProviderResponseMeta,
  ImageBlock,
} from '@mcp/code-agent/core/messages.js';
import { AbortError, TimeoutError } from './executing-abort.js';

export interface ToolUseAccumulated {
  id: string;
  name: string;
  input: Record<string, unknown>;
  /** Raw partial_json fragments collected while streaming. */
  partialJson: string[];
}

export interface StreamResult {
  textBlocks: string[];
  toolUses: ToolUseAccumulated[];
  thinkingBlocks: string[];
  generatedImages: ImageBlock[];
  usage: ChatUsage | null;
  stopReason: string;
  /** Server-side response id (Codex / ChatGPT only). */
  responseId: string | null;
  /** Companion to `responseId` — message count at the time of emit. */
  responseMessageCount: number | null;
  /**
   * Sanitized provider request/response metadata (Anthropic betas,
   * rate-limit headers, response model echo, …). Provided by providers
   * that emit a `response_meta` delta; null for the rest. Persisted in the
   * session's immutable turn metric.
   */
  responseMeta: ChatProviderResponseMeta | null;
  /** Provider-native phase, or a deterministic fallback for legacy wires. */
  messagePhase: AssistantMessagePhase;
}

export interface ConsumeStreamArgs {
  stream: AsyncIterable<ChatDelta>;
  signal?: AbortSignal;
  /** Interrupt transport I/O before asking an async generator to return. */
  cancelStream?: (reason: unknown) => void;
  onTextDelta?: (
    text: string,
    meta?: { itemId?: string; phase?: AssistantMessagePhase },
  ) => void;
  onThinkingDelta?: (text: string) => void;
  onToolCallStart?: (id: string, name: string) => void;
  /**
   * Maximum ms to wait between consecutive deltas. When the provider stalls
   * past this threshold the consumer throws — Executing turns it into a
   * retryable ProviderError so Recovering can back off and try again.
   * Default 90s; override via `CODER_STREAM_IDLE_TIMEOUT_MS`.
   */
  idleTimeoutMs?: number;
  /**
   * Max ms to wait for the FIRST delta of ANY kind (time-to-first-byte).
   * Reasoning models on heavy prompts (GLM-5/glm-5.2 with large tools+context)
   * can stay completely silent far longer than the inter-delta `idleTimeoutMs`
   * before the first token — a flat idle timeout kills them mid-think. Applies
   * ONLY until the first delta arrives; after that `idleTimeoutMs` governs the
   * gaps. Default 240s; override via `CODER_STREAM_FIRST_BYTE_TIMEOUT_MS`.
   */
  firstByteTimeoutMs?: number;
  /** Max ms a stream may emit only thinking deltas without text/tool progress. */
  thinkingOnlyTimeoutMs?: number;
}

/**
 * Timeout defaults are resolved at CALL time (not frozen at import) so a
 * `process.env` override applied after this module loads still takes effect —
 * same contract as `recoveryCap` in recovery-config.ts. Tests that stub the
 * env post-import depend on this.
 */
/**
 * Base thinking-only budget. Bumped 120s→240s to match the first-byte budget:
 * reasoning models (GLM-5/glm-5.2) on heavy plan-mode prompts legitimately
 * emit only thinking deltas for well over two minutes before the first
 * text/tool block. The old 120s killed that productive thinking and — because
 * the retry re-sent the SAME prompt — looped straight into the recovery cap.
 * Effort/attempt scaling lives in `thinkingOnlyBudgetMs`.
 */
function resolveThinkingOnlyTimeoutMs(): number {
  return 240_000;
}

/**
 * Effective thinking-only budget for a reasoning effort + retry attempt.
 *
 * Two adjustments over the flat base:
 *   - effort scale: high/xhigh reasoning legitimately thinks longer.
 *   - attempt scale: a retry of the SAME prompt only helps if it gets MORE
 *     time than the attempt that just timed out — otherwise it re-times-out
 *     identically and burns the recovery cap for nothing. Doubled per prior
 *     attempt, bounded at 4× so a genuinely degenerate reasoning loop still
 *     dies in bounded wall-clock instead of stalling the run for ~an hour.
 *
 * `attempts` is the count of thinking-timeouts ALREADY recorded this run
 * (0 on the first turn).
 */
export function thinkingOnlyBudgetMs(effort: string | undefined, attempts: number): number {
  const base = resolveThinkingOnlyTimeoutMs();
  const effortScale = effort === 'xhigh' ? 2 : effort === 'high' ? 1.5 : 1;
  const attemptScale = Math.min(2 ** Math.max(0, attempts), 4);
  return Math.round(base * effortScale * attemptScale);
}

export async function consumeStream(args: ConsumeStreamArgs): Promise<StreamResult> {
  const textBlocks: string[] = [];
  const thinkingBlocks: string[] = [];
  const imagesById = new Map<string, ImageBlock>();
  const toolUses: ToolUseAccumulated[] = [];
  const toolUsesById = new Map<string, ToolUseAccumulated>();
  let currentText = '';
  let currentThinking = '';
  let usage: ChatUsage | null = null;
  let stopReason = 'unknown';
  let responseId: string | null = null;
  let responseMessageCount: number | null = null;
  let responseMeta: ChatProviderResponseMeta | null = null;
  const messagePhases = new Set<AssistantMessagePhase>();

  const idleMs = args.idleTimeoutMs ?? 90_000;
  const firstByteMs =
    args.firstByteTimeoutMs ?? 240_000;
  const thinkingOnlyMs = args.thinkingOnlyTimeoutMs ?? resolveThinkingOnlyTimeoutMs();
  const iterator = args.stream[Symbol.asyncIterator]();
  const stopStream = (reason: unknown) => {
    try { args.cancelStream?.(reason); } catch { /* Preserve the original stop reason. */ }
    // AsyncGenerator.return() queues behind a pending next(). A provider that
    // ignores cancellation must never hold the user's stop/timeout hostage.
    try { void Promise.resolve(iterator.return?.()).catch(() => undefined); } catch { /* best-effort */ }
  };
  let lastNonThinkingAt = Date.now();
  // Until the first delta arrives, use the generous first-byte budget; after
  // that, the tighter inter-delta idle budget governs gaps.
  let receivedAny = false;
  let receivedTerminal = false;

  while (true) {
    if (args.signal?.aborted) {
      // A2 — surface abort as exception so callers (Executing node) can
      // route it to the abort path. Previously we just broke and returned
      // a partial result silently.
      const error = new AbortError('consumeStream aborted by signal');
      stopStream(error);
      throw error;
    }
    let next: IteratorResult<ChatDelta>;
    try {
      next = await raceWithTimeoutAndSignal(
        iterator.next(),
        receivedAny ? idleMs : firstByteMs,
        args.signal,
        receivedAny
          ? undefined
          : {
              label: 'provider produced no first byte within',
              tuneEnv: 'CODER_STREAM_FIRST_BYTE_TIMEOUT_MS',
            },
      );
    } catch (e) {
      const error = args.signal?.aborted ? new AbortError('consumeStream aborted by signal') : e;
      stopStream(error);
      throw error;
    }
    if (next.done) break;
    const delta = next.value;
    receivedAny = true;

    switch (delta.type) {
      case 'text_delta':
        lastNonThinkingAt = Date.now();
        currentText += delta.text;
        if (delta.phase) messagePhases.add(delta.phase);
        args.onTextDelta?.(delta.text, {
          ...(delta.itemId ? { itemId: delta.itemId } : {}),
          ...(delta.phase ? { phase: delta.phase } : {}),
        });
        break;

      case 'thinking_delta':
        if (thinkingOnlyMs > 0 && Date.now() - lastNonThinkingAt > thinkingOnlyMs) {
          const err = new TimeoutError(thinkingOnlyMs, 'provider thinking-only stream');
          err.message =
            `provider thinking-only stream exceeded ${thinkingOnlyMs}ms — aborting turn. ` +
            `Tune CODER_STREAM_THINKING_ONLY_TIMEOUT_MS.`;
          (err as { status?: number }).status = 504;
          // Distinct marker so `providerErrorEvent` tags this as THINKING_TIMEOUT
          // and Recovering routes it to its own low-cap bucket instead of
          // sharing `provider-unknown-retry` with connection/mid-stream drops.
          (err as { reason?: string }).reason = 'thinking-only';
          stopStream(err);
          throw err;
        }
        currentThinking += delta.text;
        args.onThinkingDelta?.(delta.text);
        break;

      case 'tool_call_start': {
        lastNonThinkingAt = Date.now();
        // Flush any accumulated text BEFORE this tool_use boundary —
        // well-formed streams emit `[text, tool_use, text?, ...]`.
        // We do NOT allocate the ToolUseAccumulated here: providers like
        // openai.ts (used by ZAI/GLM/DeepSeek) may emit `tool_call_start`
        // with a placeholder id (`tool_${idx}`) and only commit the REAL
        // id on `tool_call_end` — so `start` and `end` ids can differ.
        // The legacy `handleDelta` (runner.ts) follows the same rule:
        // only `tool_call_end` is authoritative.
        if (currentText) {
          textBlocks.push(currentText);
          currentText = '';
        }
        args.onToolCallStart?.(delta.id, delta.name);
        break;
      }

      case 'tool_call_args': {
        // Ignored — `tool_call_end` ships the fully-parsed input. The
        // legacy loop also ignores this delta (runner.ts handleDelta).
        break;
      }

      case 'tool_call_end': {
        lastNonThinkingAt = Date.now();
        // Authoritative: create the tool_use block here with the final id
        // and parsed input. Dedup by id in case a misbehaving provider
        // emits `end` more than once for the same call.
        if (toolUsesById.has(delta.id)) break;
        const tu: ToolUseAccumulated = {
          id: delta.id,
          name: delta.name,
          input: delta.input ?? {},
          partialJson: [],
        };
        toolUsesById.set(delta.id, tu);
        toolUses.push(tu);
        break;
      }

      case 'usage':
        lastNonThinkingAt = Date.now();
        usage = delta.usage;
        break;

      case 'response_id':
        responseId = delta.id;
        responseMessageCount = delta.messageCount;
        break;

      case 'done':
        lastNonThinkingAt = Date.now();
        receivedTerminal = true;
        stopReason = delta.stop_reason ?? 'unknown';
        break;

      case 'response_meta':
        // Mirror the legacy handleDelta capture: keep the most recent
        // emission (providers send it at most once per turn). Telemetry
        // (mig 093) consumes this on the BT side via `result.responseMeta`.
        responseMeta = delta.meta;
        break;

      case 'image_generated': {
        lastNonThinkingAt = Date.now();
        const extension = ({ 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' } as Record<string, string>)[delta.mediaType] ?? 'bin';
        imagesById.set(delta.id, {
          type: 'image', mediaType: delta.mediaType, base64: delta.base64,
          name: `generated-${delta.id.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 100)}.${extension}`,
        });
        break;
      }
    }
  }

  // EOF is not a successful provider response by itself. Accepting partial
  // text/tool deltas without the protocol terminal made connection drops look
  // like completed turns and could dispatch an incomplete tool call. Claude's
  // runtime likewise classifies a stream that ends without its result event as
  // `stream_ended_no_result`.
  if (!receivedTerminal) {
    const error = new Error(
      'provider stream ended before the terminal result event (stream_ended_no_result)',
    );
    error.name = 'ProviderStreamProtocolError';
    Object.assign(error, {
      status: 502,
      code: 'stream_ended_no_result',
      reason: 'stream_ended_no_result',
      // Sanitized transport metadata may still prove the physical HTTP status
      // and request id even though the application-level result was missing.
      responseMeta,
      generationId: responseId,
    });
    throw error;
  }

  // Flush trailing buffers after the provider has explicitly committed the
  // response with `done`.
  if (currentText) textBlocks.push(currentText);
  if (currentThinking) thinkingBlocks.push(currentThinking);

  // A terminal marker commits the transport, but it does not by itself make
  // the model turn usable. Some OpenAI-compatible endpoints occasionally
  // return HTTP 200 + finish_reason with no assistant text and no tool call.
  // Treat that as a retryable protocol failure instead of persisting a clean
  // completion that leaves the user with an empty turn. Thinking alone is not
  // a deliverable: the model still owes visible text, an image or a tool request.
  const hasVisibleText = textBlocks.some((text) => text.trim().length > 0);
  if (!hasVisibleText && toolUses.length === 0 && imagesById.size === 0) {
    const error = new Error(
      'provider committed an empty terminal response (provider_empty_result)',
    );
    error.name = 'ProviderStreamProtocolError';
    Object.assign(error, {
      status: 502,
      code: 'provider_empty_result',
      reason: 'provider_empty_result',
      responseMeta,
      generationId: responseId,
    });
    throw error;
  }

  // Phase-aware providers identify public commentary directly. Legacy wires
  // get a deterministic equivalent: text alongside a tool request is progress;
  // text in a tool-free terminal response is the final answer.
  const messagePhase = messagePhases.size === 1
    ? [...messagePhases][0]!
    : toolUses.length > 0
      ? 'commentary'
      : 'final_answer';

  return {
    textBlocks,
    toolUses,
    thinkingBlocks,
    generatedImages: [...imagesById.values()],
    usage,
    stopReason,
    responseId,
    responseMessageCount,
    responseMeta,
    messagePhase,
  };
}

/**
 * Race a promise against (a) idle-timeout AND (b) user-abort signal. The
 * first to fire wins. Both branches clean up after themselves so we don't
 * leak timers or listeners on the happy path.
 *
 * A2 (Frente A) added the signal branch — before this, an aborted run
 * had to wait up to `idleMs` (default 90s) for the timeout to surface
 * the cancellation. Now the user's abort is honoured within ~ a tick.
 */
async function raceWithTimeoutAndSignal<T>(
  p: Promise<T>,
  ms: number,
  signal?: AbortSignal,
  opts?: { label?: string; tuneEnv?: string },
): Promise<T> {
  const label = opts?.label ?? 'provider stream idle';
  const tuneEnv = opts?.tuneEnv ?? 'CODER_STREAM_IDLE_TIMEOUT_MS';
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => {
        const err = new TimeoutError(ms, label);
        err.message = `${label} ${ms}ms — aborting turn. Tune ${tuneEnv}.`;
        (err as { status?: number }).status = 504; // gateway-timeout-ish so Recovering treats as retryable
        reject(err);
      }, ms);
      if (signal) {
        if (signal.aborted) {
          reject(new AbortError('consumeStream aborted by signal'));
          return;
        }
        // Signals crossing MessageBridge/worker boundaries can retain the
        // `aborted` flag but lose EventTarget prototype methods. Treat those
        // as poll-only signals instead of crashing the provider stream.
        if (typeof signal.addEventListener === 'function') {
          onAbort = (): void => reject(new AbortError('consumeStream aborted by signal'));
          signal.addEventListener('abort', onAbort, { once: true });
        }
      }
      p.then(resolve, reject);
    });
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort && signal && typeof signal.removeEventListener === 'function') {
      signal.removeEventListener('abort', onAbort);
    }
  }
}

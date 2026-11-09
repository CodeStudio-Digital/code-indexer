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
   * Default 90s. Real transport activity also renews this inactivity window.
   */
  idleTimeoutMs?: number;
  /**
   * Max ms to wait for the FIRST delta of ANY kind (time-to-first-byte).
   * Reasoning models on heavy prompts (GLM-5/glm-5.2 with large tools+context)
   * can stay completely silent far longer than the inter-delta `idleTimeoutMs`
   * before the first token — a flat idle timeout kills them mid-think. Applies
   * ONLY until the first delta arrives; after that `idleTimeoutMs` governs the
   * gaps. Default 240s.
   */
  firstByteTimeoutMs?: number;
  /** Monotonic time of real received transport data (performance.now()).
   * SDKs can consume pings or encrypted thinking without yielding a ChatDelta.
   * Local UI heartbeats must never update this timestamp.
   */
  lastTransportActivityAt?: () => number | undefined;
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
  const iterator = args.stream[Symbol.asyncIterator]();
  const stopStream = (reason: unknown) => {
    try { args.cancelStream?.(reason); } catch { /* Preserve the original stop reason. */ }
    // AsyncGenerator.return() queues behind a pending next(). A provider that
    // ignores cancellation must never hold the user's stop/timeout hostage.
    try { void Promise.resolve(iterator.return?.()).catch(() => undefined); } catch { /* best-effort */ }
  };
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
        {
          label: receivedAny ? 'provider stream idle' : 'provider produced no first byte within',
          lastTransportActivityAt: args.lastTransportActivityAt,
          idleTimeoutMs: idleMs,
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
        currentText += delta.text;
        if (delta.phase) messagePhases.add(delta.phase);
        args.onTextDelta?.(delta.text, {
          ...(delta.itemId ? { itemId: delta.itemId } : {}),
          ...(delta.phase ? { phase: delta.phase } : {}),
        });
        break;

      case 'thinking_delta':
        // Reasoning is productive stream activity, regardless of its duration.
        // Retrying a live response discards that work and repeats its cost.
        currentThinking += delta.text;
        args.onThinkingDelta?.(delta.text);
        break;

      case 'tool_call_start': {
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
        usage = delta.usage;
        break;

      case 'response_id':
        responseId = delta.id;
        responseMessageCount = delta.messageCount;
        break;

      case 'done':
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
  opts?: { label?: string; lastTransportActivityAt?: () => number | undefined; idleTimeoutMs?: number },
): Promise<T> {
  const label = opts?.label ?? 'provider stream idle';
  const startedAt = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      // iterator.next() can synchronously abort before returning its promise.
      // Subscribe before any early return so its rejection is always observed.
      p.then(resolve, reject);
      const checkIdle = () => {
        const now = performance.now();
        const transportAt = opts?.lastTransportActivityAt?.();
        const hasTransportActivity = typeof transportAt === 'number' && Number.isFinite(transportAt)
          && transportAt >= startedAt && transportAt <= now;
        const timeoutMs = hasTransportActivity ? (opts?.idleTimeoutMs ?? ms) : ms;
        const remaining = timeoutMs - (now - (hasTransportActivity ? transportAt : startedAt));
        if (remaining > 0) {
          // One timer per outstanding next(), not one timer per network chunk.
          timer = setTimeout(checkIdle, remaining);
          return;
        }
        const timeoutLabel = hasTransportActivity ? 'provider stream idle' : label;
        const err = new TimeoutError(timeoutMs, timeoutLabel);
        err.message = `${timeoutLabel} ${timeoutMs}ms without received activity — cancelling the stalled request.`;
        (err as { status?: number }).status = 504; // gateway-timeout-ish so Recovering treats as retryable
        reject(err);
      };
      timer = setTimeout(checkIdle, ms);
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
    });
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort && signal && typeof signal.removeEventListener === 'function') {
      signal.removeEventListener('abort', onAbort);
    }
  }
}

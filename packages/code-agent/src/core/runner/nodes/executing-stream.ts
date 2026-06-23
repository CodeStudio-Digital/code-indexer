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
import type { ChatDelta, ChatUsage, ChatProviderResponseMeta } from '@mcp/code-agent/core/messages.js';
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
  usage: ChatUsage | null;
  stopReason: string;
  /** Server-side response id (Codex / ChatGPT only). */
  responseId: string | null;
  /** Companion to `responseId` — message count at the time of emit. */
  responseMessageCount: number | null;
  /**
   * Sanitized provider request/response metadata (Anthropic betas,
   * rate-limit headers, response model echo, …). Provided by providers
   * that emit a `response_meta` delta; null for the rest. Persisted by
   * `coder_turn_telemetry` (migration 093).
   */
  responseMeta: ChatProviderResponseMeta | null;
}

export interface ConsumeStreamArgs {
  stream: AsyncIterable<ChatDelta>;
  signal?: AbortSignal;
  onTextDelta?: (text: string) => void;
  onThinkingDelta?: (text: string) => void;
  onToolCallStart?: (id: string, name: string) => void;
  /**
   * Maximum ms to wait between consecutive deltas. When the provider stalls
   * past this threshold the consumer throws — Executing turns it into a
   * retryable ProviderError so Recovering can back off and try again.
   * Default 90s; override via `CODER_STREAM_IDLE_TIMEOUT_MS`.
   */
  idleTimeoutMs?: number;
  /** Max ms a stream may emit only thinking deltas without text/tool progress. */
  thinkingOnlyTimeoutMs?: number;
}

const DEFAULT_IDLE_TIMEOUT_MS = (() => {
  const v = process.env.CODER_STREAM_IDLE_TIMEOUT_MS;
  if (v != null && v !== '') {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 90_000;
})();

const DEFAULT_THINKING_ONLY_TIMEOUT_MS = (() => {
  const v = process.env.CODER_STREAM_THINKING_ONLY_TIMEOUT_MS;
  if (v != null && v !== '') {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return 120_000;
})();

export async function consumeStream(args: ConsumeStreamArgs): Promise<StreamResult> {
  const textBlocks: string[] = [];
  const thinkingBlocks: string[] = [];
  const toolUses: ToolUseAccumulated[] = [];
  const toolUsesById = new Map<string, ToolUseAccumulated>();
  let currentText = '';
  let currentThinking = '';
  let usage: ChatUsage | null = null;
  let stopReason = 'unknown';
  let responseId: string | null = null;
  let responseMessageCount: number | null = null;
  let responseMeta: ChatProviderResponseMeta | null = null;

  const idleMs = args.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
  const thinkingOnlyMs = args.thinkingOnlyTimeoutMs ?? DEFAULT_THINKING_ONLY_TIMEOUT_MS;
  const iterator = args.stream[Symbol.asyncIterator]();
  let lastNonThinkingAt = Date.now();

  while (true) {
    if (args.signal?.aborted) {
      // A2 — surface abort as exception so callers (Executing node) can
      // route it to the abort path. Previously we just broke and returned
      // a partial result silently.
      try { await iterator.return?.(); } catch { /* ignore */ }
      throw new AbortError('consumeStream aborted by signal');
    }
    let next: IteratorResult<ChatDelta>;
    try {
      next = await raceWithTimeoutAndSignal(iterator.next(), idleMs, args.signal);
    } catch (e) {
      // Cooperatively cancel the iterator if it supports return().
      try {
        await iterator.return?.();
      } catch {
        /* ignore */
      }
      throw e;
    }
    if (next.done) break;
    const delta = next.value;

    switch (delta.type) {
      case 'text_delta':
        lastNonThinkingAt = Date.now();
        currentText += delta.text;
        args.onTextDelta?.(delta.text);
        break;

      case 'thinking_delta':
        if (thinkingOnlyMs > 0 && Date.now() - lastNonThinkingAt > thinkingOnlyMs) {
          try { await iterator.return?.(); } catch { /* ignore */ }
          const err = new TimeoutError(thinkingOnlyMs, 'provider thinking-only stream');
          (err as { status?: number }).status = 504;
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
        stopReason = delta.stop_reason ?? 'unknown';
        break;

      case 'response_meta':
        // Mirror the legacy handleDelta capture: keep the most recent
        // emission (providers send it at most once per turn). Telemetry
        // (mig 093) consumes this on the BT side via `result.responseMeta`.
        responseMeta = delta.meta;
        break;

      // 'image_generated' currently ignored — the Executing minimal
      // scope doesn't synthesize ImageBlocks yet.
    }
  }

  // Flush trailing buffers in case the stream ended without an explicit
  // boundary (some providers don't emit `done` cleanly).
  if (currentText) textBlocks.push(currentText);
  if (currentThinking) thinkingBlocks.push(currentThinking);

  return {
    textBlocks,
    toolUses,
    thinkingBlocks,
    usage,
    stopReason,
    responseId,
    responseMessageCount,
    responseMeta,
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
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  try {
    return await new Promise<T>((resolve, reject) => {
      timer = setTimeout(() => {
        const err = new TimeoutError(ms, 'provider stream idle');
        err.message =
          `provider stream idle ${ms}ms — aborting turn. Tune CODER_STREAM_IDLE_TIMEOUT_MS.`;
        (err as { status?: number }).status = 504; // gateway-timeout-ish so Recovering treats as retryable
        reject(err);
      }, ms);
      if (signal) {
        if (signal.aborted) {
          reject(new AbortError('consumeStream aborted by signal'));
          return;
        }
        onAbort = (): void => reject(new AbortError('consumeStream aborted by signal'));
        signal.addEventListener('abort', onAbort, { once: true });
      }
      p.then(resolve, reject);
    });
  } finally {
    if (timer) clearTimeout(timer);
    if (onAbort && signal) signal.removeEventListener('abort', onAbort);
  }
}

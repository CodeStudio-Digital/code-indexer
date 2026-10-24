/**
 * binding-failover — run a chat call across a resolver failover chain.
 *
 * `PipelineProviderResolver.resolveChain()` returns every enabled binding for
 * a pipeline+role (best-first, plus the general default appended). This helper
 * walks that chain and calls each binding until one succeeds, so a second
 * configured binding finally acts as real redundancy instead of dead weight.
 *
 * Layering with `withChatRetry`:
 *   - `withChatRetry` retries the SAME binding on the transient rate-limit
 *     family (429/408/5xx) — a provider that's momentarily throttled.
 *   - THIS helper fails over to the NEXT binding when a binding is broken in
 *     a way retrying won't fix (auth/config error, dead endpoint, empty reply,
 *     or a persistent error the retry loop already exhausted).
 *
 * What counts as failure (advance to the next binding):
 *   - a pre-flight `bindingProblem()` (unsupported kind, missing credentials),
 *   - a chat result carrying `errorBody`,
 *   - an empty reply (no text) — matches the distiller's "no text = failure".
 * Parsed content is the CALLER's concern: this layer only sees the transport
 * result, so a non-empty errorBody-free reply is always "success" here.
 */
import type { ResolvedBinding } from '../pipelines/index.js';
import { bindingProblem } from './binding-chat.js';
import { abortedChatResult, withChatRetry, type ChatRetryOptions } from './chat-retry.js';
import type { ChatCallResult } from './llm-chat.js';

export interface FailoverOptions {
  /** Caller cancellation is terminal for the entire chain, including retries. */
  signal?: AbortSignal;
  /** Per-binding retry policy (passed straight to `withChatRetry`). */
  retry?: ChatRetryOptions;
  /**
   * Optional caller-owned content validator. Returning a message marks an
   * otherwise successful non-empty response as failed while preserving its
   * raw content for diagnostics and allowing the normal failover chain to run.
   */
  validateResult?: (
    result: ChatCallResult,
    binding: ResolvedBinding,
  ) => string | null | undefined;
  /**
   * Extra attempts on the same binding after `validateResult` rejects content.
   * Transport retries remain governed independently by `retry`. Default 0.
   */
  invalidResultRetries?: number;
  /** Human label for `bindingProblem()` diagnostics (e.g. "docs relevance classifier"). */
  label?: string;
  /** Namespace for machine-readable `bindingProblem()` codes (e.g. "doc_ingest"). */
  codePrefix?: string;
  /** Skip the pre-flight `bindingProblem()` config check — for modalities it
   *  doesn't model (vision/transcription). Default false. */
  skipValidation?: boolean;
  /** Treat an errorBody-free but empty reply as a failure worth failing over.
   *  Default true (a classifier/distiller needs actual text). */
  treatEmptyAsError?: boolean;
}

export interface FailoverResult {
  /** Chat result from the winning binding, or the last failing one. */
  result: ChatCallResult;
  /** The binding that produced `result`; null only when the chain was empty. */
  binding: ResolvedBinding | null;
  /** Index of `binding` within the chain (-1 when the chain was empty). */
  attemptIndex: number;
  /** True when at least one earlier binding failed before this one served. */
  failedOver: boolean;
  /** Physical provider requests, excluding preflight config failures. */
  providerCalls: number;
}

/**
 * Call `runOne` against each binding in `chain` until one returns a usable
 * reply. Returns the winning result (or the last failure). Never throws —
 * mirrors the chat helpers' "errors come back as `errorBody`" contract.
 */
export async function callChatWithFailover(
  chain: ResolvedBinding[],
  runOne: (binding: ResolvedBinding) => Promise<ChatCallResult>,
  opts: FailoverOptions = {},
): Promise<FailoverResult> {
  const signal = opts.signal && opts.retry?.signal && opts.signal !== opts.retry.signal
    ? AbortSignal.any([opts.signal, opts.retry.signal]) : opts.signal ?? opts.retry?.signal;
  if (signal?.aborted) {
    return { result: abortedChatResult(), binding: null, attemptIndex: -1, failedOver: false, providerCalls: 0 };
  }
  if (chain.length === 0) {
    return {
      result: { content: '', errorBody: '[no_binding] empty failover chain', latencyMs: 0 },
      binding: null,
      attemptIndex: -1,
      failedOver: false,
      providerCalls: 0,
    };
  }

  const treatEmptyAsError = opts.treatEmptyAsError ?? true;
  let last: ChatCallResult = { content: '', errorBody: '[no_binding] empty failover chain', latencyMs: 0 };
  let lastBinding: ResolvedBinding = chain[0];
  let lastIndex = 0;
  let providerCalls = 0;
  const invalidResultRetries = Math.max(0, Math.floor(opts.invalidResultRetries ?? 0));
  const cancelled = (): FailoverResult => ({ result: abortedChatResult(last), binding: lastBinding,
    attemptIndex: lastIndex, failedOver: lastIndex > 0, providerCalls });

  for (let i = 0; i < chain.length; i++) {
    if (signal?.aborted) return cancelled();
    const binding = chain[i];
    lastBinding = binding;
    lastIndex = i;

    if (!opts.skipValidation) {
      const problem = bindingProblem(binding, {
        label: opts.label ?? `${binding.pipelineName}/${binding.bindingRole}`,
        codePrefix: opts.codePrefix ?? binding.bindingRole,
      });
      if (problem) {
        last = { content: '', errorBody: `[${problem.code}] ${problem.message}`, latencyMs: 0 };
        continue; // misconfigured binding → try the next one
      }
    }

    for (let invalidAttempt = 0; ; invalidAttempt++) {
      if (signal?.aborted) return cancelled();
      let result: ChatCallResult;
      try {
        result = await withChatRetry(() => {
          providerCalls += 1;
          return runOne(binding);
        }, { ...opts.retry, signal });
      } catch (e) {
        // A chat fn that throws (network layer, adapter bug) is a transport
        // failure too — turn it into a result so we fail over instead of
        // exploding, honoring the "never throws" contract.
        result = e instanceof Error && e.name === 'AbortError' ? abortedChatResult()
          : { content: '', errorBody: e instanceof Error ? e.message : String(e), latencyMs: 0 };
      }

      last = result;
      if (signal?.aborted) return cancelled();
      if (result.finishReason === 'aborted') {
        return { result: abortedChatResult(result), binding, attemptIndex: i, failedOver: i > 0, providerCalls };
      }

      const nonEmpty = (result.content ?? '').trim().length > 0;
      if (!result.errorBody && nonEmpty && opts.validateResult) {
        let validationError: string | null | undefined;
        try {
          validationError = opts.validateResult(result, binding);
        } catch (e) {
          validationError = e instanceof Error ? e.message : String(e);
        }
        if (signal?.aborted) return cancelled();
        if (validationError) {
          result = { ...result, errorBody: validationError };
          last = result;
          if (invalidAttempt < invalidResultRetries) continue;
        }
      }

      last = result;
      const usable = !result.errorBody && (!treatEmptyAsError || nonEmpty);
      if (usable) {
        return { result, binding, attemptIndex: i, failedOver: i > 0, providerCalls };
      }
      break;
    }
    // errored / empty → fall over to the next binding (if any)
  }

  return { result: last, binding: lastBinding, attemptIndex: lastIndex, failedOver: chain.length > 1, providerCalls };
}

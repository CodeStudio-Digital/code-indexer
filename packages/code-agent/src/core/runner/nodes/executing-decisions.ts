/**
 * Helper functions extracted from `executing.ts` to keep the main node
 * body lean. Pure (or near-pure) functions:
 *   - `decideTerminal` — pick the next BT event after a tool-bearing turn
 *     considering max-turns + auto-continue policy.
 *   - `providerErrorEvent` — utility.
 */
import type { BehaviorEvent, RunContext } from '../machine/types.js';
import { events } from '../machine/events.js';
import { isTimeoutError } from './executing-abort.js';
import { checkMaxTurns, maxAutoContinues } from '../guards/max-turns.js';
import { providerTransportError } from '@mcp/provider-sdk/transport-error.js';
import { isToolSchemaRejection } from '../provider-schema-recovery.js';

const DEBUG = process.env.CODER_BT_DEBUG === '1';

/**
 * Decide the terminal event for a turn that produced tool calls. Applies
 * the max-turns guard: continue, auto-continue (with recap reminder), or
 * stop with `MaxTurnsReached`.
 */
export function decideTerminal(ctx: RunContext): BehaviorEvent {
  // Ephemeral children are free-running by default. A zero/omitted maxTurns
  // means "until natural completion" and deliberately bypasses the parent's
  // session-owned auto-continue batches. When an operator supplies a positive
  // cap, it is an exact child-only ceiling (no automatic extension).
  if (ctx.opts.isSubagent) {
    const subagentMaxTurns = ctx.opts.maxTurns ?? 0;
    if (subagentMaxTurns <= 0 || ctx.turn < subagentMaxTurns) {
      return events.turnSucceeded({ hasToolCalls: true });
    }
    ctx.stopReason = 'max_turns';
    return events.maxTurnsReached({ autoContinueLeft: 0 });
  }

  const maxTurns = ctx.opts.maxTurns ?? 0;
  if (maxTurns <= 0) {
    return events.turnSucceeded({ hasToolCalls: true });
  }
  // A plan is a bounded decision artifact, not an implementation marathon.
  // If it cannot converge within its current turn budget, stop instead of
  // multiplying that budget through automatic continuation batches.
  const autoContinueCap = ctx.opts.planMode
    ? 0
    : (ctx.opts.maxAutoContinues ?? maxAutoContinues());
  const verdict = checkMaxTurns({
    turn: ctx.turn,
    autoContinues: ctx.autoContinues,
    maxTurns,
  }, autoContinueCap);

  if (verdict.kind === 'continue') {
    return events.turnSucceeded({ hasToolCalls: true });
  }

  if (verdict.kind === 'auto-continue') {
    ctx.autoContinues = verdict.nextCount;
    const cap = autoContinueCap;
    ctx.emit('auto_continue', verdict.nextCount, cap);
    // Each auto-continue grants a fresh batch of ~maxTurns turns. On
    // intermediate batches, nudge the model to keep working (the old
    // "wrap up" nag fired every turn and stalled progress). Only on the
    // FINAL batch do we ask it to land the plane.
    const isFinal = verdict.nextCount >= cap;
    const text = isFinal
      ? `<system-reminder>auto-continue ${verdict.nextCount}/${cap} (último lote) — ` +
        `mais ~${maxTurns} turnos e acabou. Finalize o trabalho em andamento e encerre; ` +
        `não inicie novas investigações.</system-reminder>`
      : `<system-reminder>auto-continue ${verdict.nextCount}/${cap} — concedidos ~${maxTurns} ` +
        `turnos extras. Continue fazendo progresso concreto na tarefa.</system-reminder>`;
    ctx.messages.push({
      role: 'user',
      content: [{ type: 'text', text }],
    });
    return events.turnSucceeded({ hasToolCalls: false });
  }

  // verdict.kind === 'stop'
  ctx.stopReason = 'max_turns';
  return events.maxTurnsReached({ autoContinueLeft: 0 });
}

/**
 * Substrings that mark a clearly non-retryable provider failure. Kept
 * conservative: each phrase only appears in genuinely fatal responses
 * (model/auth/quota/param errors), never in transient 5xx/429 bodies.
 * Matched case-insensitively against the extracted message. Used only when
 * the error carries NO numeric HTTP status (mid-stream / connection / parse
 * errors that the OpenAI SDK surfaces without a `.status`).
 */
const FATAL_SIGNATURES = [
  'not found',
  'does not exist',
  'no such model',
  'unsupported',
  'unknown field',
  'invalid api key',
  'invalid_api_key',
  'invalid_request',
  'unauthorized',
  'permission',
  'insufficient',
  'quota',
] as const;

/**
 * Build a `ProviderError` event from a thrown provider error. Extracts the
 * HTTP status, human message and provider error code from the various shapes
 * the OpenAI SDK throws (`APIError` with `.status`, `APIConnectionError`
 * without one, mid-stream errors carrying a `.error.message` body), LOGS the
 * real message unconditionally (so the cause is visible without
 * `CODER_BT_DEBUG`), and classifies retryability.
 *
 * Status-less errors get the sentinel `status: 0`, routed by `recovering.ts`
 * to the transport or unknown recovery path — UNLESS the message matches a
 * fatal signature, in which case it's marked non-retryable so the run aborts
 * immediately with the real message instead of looping ~30× / ~5min.
 */
export function providerErrorEvent(e: unknown): BehaviorEvent {
  const status = extractStatus(e);
  const transport = status === undefined || status === 0 || isTimeoutError(e)
    ? providerTransportError(e) : null;
  const message = transport?.message ?? extractMessage(e);
  const code = transport?.code ?? extractCode(e);

  // Single-line, truncated, always-on. This is the line that finally tells
  // the user WHAT the provider rejected.
  console.warn(
    `[coder] ProviderError status=${status ?? 'n/a'}` +
      `${code ? ` code=${code}` : ''} message=${JSON.stringify(truncate(message, 500))}`,
  );

  // Stream idle / first-byte timeouts use bounded consecutive transport retries,
  // while preserving the shared run budget. The diagnostic remains secret-free.
  // Preserve classification of legacy provider/plugin thinking timeouts.
  // The host no longer produces these while reasoning is still active.
  if (isToolSchemaRejection(message, code)) {
    return events.providerError({ retryable: false, status: status ?? 0, message, ...(code ? { code } : {}) });
  }

  if (isTimeoutError(e)) {
    const thinkingOnly = (e as { reason?: string }).reason === 'thinking-only';
    return events.providerError({
      retryable: true,
      status: 0,
      message,
      ...(thinkingOnly ? { code: 'THINKING_TIMEOUT' } : code ? { code } : {}),
    });
  }

  if (typeof status === 'number') {
    return events.providerError({
      retryable: status >= 500 || status === 429 || status === 401,
      status,
      message,
      ...(code ? { code } : {}),
    });
  }

  // No HTTP status: timeout / connection drop / mid-stream or parse error.
  const fatal = matchesFatalSignature(message);
  return events.providerError({
    retryable: !fatal,
    status: 0,
    message,
    ...(code ? { code } : {}),
  });
}

function matchesFatalSignature(message: string): boolean {
  const m = message.toLowerCase();
  return FATAL_SIGNATURES.some((sig) => m.includes(sig));
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

/** Pull an HTTP status from the assorted error shapes the SDK throws. */
function extractStatus(e: unknown): number | undefined {
  if (e && typeof e === 'object') {
    const obj = e as {
      status?: unknown;
      statusCode?: unknown;
      response?: { status?: unknown };
    };
    if (typeof obj.status === 'number') return obj.status;
    if (typeof obj.statusCode === 'number') return obj.statusCode;
    if (obj.response && typeof obj.response.status === 'number') {
      return obj.response.status;
    }
  }
  return undefined;
}

/** Best-effort human message: SDK message, OpenAI-compat error body, or JSON. */
function extractMessage(e: unknown): string {
  if (e instanceof Error && e.message) return e.message;
  if (e && typeof e === 'object') {
    const obj = e as { error?: { message?: unknown }; message?: unknown };
    if (obj.error && typeof obj.error.message === 'string') return obj.error.message;
    if (typeof obj.message === 'string' && obj.message) return obj.message;
    try {
      return JSON.stringify(obj);
    } catch {
      return String(obj);
    }
  }
  return String(e);
}

/** Provider error code/type when present (e.g. `model_not_found`). */
function extractCode(e: unknown): string | undefined {
  if (e && typeof e === 'object') {
    const obj = e as { code?: unknown; error?: { code?: unknown; type?: unknown } };
    if (typeof obj.code === 'string' && obj.code) return obj.code;
    if (obj.error) {
      if (typeof obj.error.code === 'string' && obj.error.code) return obj.error.code;
      if (typeof obj.error.type === 'string' && obj.error.type) return obj.error.type;
    }
  }
  return undefined;
}

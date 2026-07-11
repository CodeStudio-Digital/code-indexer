/**
 * Opt-in diagnostic logging for the Kimi-Code provider. Enabled by
 * `KIMI_CODE_DEBUG=1` (or alias `CODER_PROVIDER_DEBUG=1`). Zero overhead
 * when disabled — the boolean is captured at module load and gates every
 * call site.
 *
 * Purpose: capture observable evidence for the hypotheses listed in
 * `docs/debugging-kimi-loop.md` and in the parent investigation plan:
 *
 *   H1 — JSON corrupted in argsAcc (parse fails → `_raw` fallback).
 *   H2 — content "" / whitespace-only sent with tool_calls (Kimi rejects).
 *   H3 — tool_call_args emitted before tool_call_start (ordering).
 *   H4 — runner doom-loop guards mask root cause (covered by structured
 *        tool_loop_intervention events and their snapshots).
 *   H5 — model loops independently of our parsing (input arrives intact).
 *
 * Output format: one JSON line per event on stderr prefixed `[kimi-debug]`.
 * Easy to grep, easy to correlate with turn boundaries from the runner.
 */
const ENABLED =
  process.env.KIMI_CODE_DEBUG === '1' || process.env.CODER_PROVIDER_DEBUG === '1';

const MAX_PREVIEW = 200;

function preview(s: string | undefined | null): string {
  if (!s) return '';
  return s.length <= MAX_PREVIEW ? s : `${s.slice(0, MAX_PREVIEW)}…(+${s.length - MAX_PREVIEW})`;
}

export function kimiDebugEnabled(): boolean {
  return ENABLED;
}

export interface KimiDebugRequestSummary {
  model: string;
  messageRoles: string[];
  messageCount: number;
  toolCount: number;
  hasThinking: boolean;
  promptCacheKey?: string;
  assistantContentTypes?: Array<string | 'omitted'>;
}

export function logKimiRequest(summary: KimiDebugRequestSummary): void {
  if (!ENABLED) return;
  process.stderr.write(
    `[kimi-debug] ${JSON.stringify({ event: 'request', ...summary })}\n`,
  );
}

export function logKimiToolChunk(args: {
  idx: number;
  id: string | undefined;
  name: string | undefined;
  argsDelta: string | undefined;
  argsAccLen: number;
  emittedStart: boolean;
}): void {
  if (!ENABLED) return;
  process.stderr.write(
    `[kimi-debug] ${JSON.stringify({
      event: 'tool_chunk',
      idx: args.idx,
      id: args.id,
      name: args.name,
      argsDelta: preview(args.argsDelta),
      argsAccLen: args.argsAccLen,
      emittedStart: args.emittedStart,
    })}\n`,
  );
}

export function logKimiToolFlush(args: {
  id: string;
  name: string;
  argsAccLen: number;
  parseOk: boolean;
  argsPreview: string;
}): void {
  if (!ENABLED) return;
  process.stderr.write(
    `[kimi-debug] ${JSON.stringify({
      event: 'tool_flush',
      id: args.id,
      name: args.name,
      argsAccLen: args.argsAccLen,
      parseOk: args.parseOk,
      argsPreview: preview(args.argsPreview),
    })}\n`,
  );
}

export function logKimiFinish(args: { stopReason?: string; finishedNormally: boolean }): void {
  if (!ENABLED) return;
  process.stderr.write(
    `[kimi-debug] ${JSON.stringify({ event: 'finish', ...args })}\n`,
  );
}

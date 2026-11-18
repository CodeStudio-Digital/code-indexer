/**
 * distill-call — the ONE way memory distillers reach their LLM binding.
 *
 * Why it exists: the distillers used to call `pickChatFn` directly, which
 * routes OAuth kinds (google-oauth, chatgpt, …) to the raw REST adapters that
 * authenticate by API key only — every call failed with 400/401, the adapter
 * returned `{content:'', errorBody}` without throwing, and the pass logged as
 * `empty` as if the session had nothing durable. This helper dispatches via
 * `callConfiguredChat` (full coder client for OAuth kinds, token refresh
 * included) and turns transport failures into a TYPED error so the distill
 * log can finally distinguish "the call broke" from "nothing to learn".
 *
 * Also owns the defensive response parser (moved from distiller.ts so the
 * import edge stays one-directional) and a one-shot general-default fallback
 * retry when the bound provider fails at runtime.
 */
import type { SnapshotCategory } from '@mcp/shared/types.js';
import type { FallbackDefault, PipelineProviderResolver, ResolveContext, ResolvedBinding } from '../pipelines/index.js';
import { callConfiguredChat } from '../quality/binding-chat.js';
import { callChatWithFailover } from '../quality/binding-failover.js';
import { suppressThinkingFor } from '../quality/chat-dispatcher.js';
import type { ChatCallResult, ChatMessage } from '../quality/llm-chat.js';
import type { MemoryCandidate } from './extractor.js';

export type DistillOutcome = 'ok' | 'llm_error' | 'no_facts' | 'parse_empty';

export interface DistillDiag {
  outcome: DistillOutcome;
  providerId?: string;
  modelId?: string;
  resolvedFrom?: string;
  httpStatus?: number;
  errorSnippet?: string;
  rawChars: number;
  latencyMs: number;
  /** True when the general-default fallback served the call after the bound provider failed. */
  fallbackUsed?: boolean;
}

export class DistillLlmError extends Error {
  constructor(readonly diag: DistillDiag) {
    super(
      `${diag.outcome}${diag.httpStatus ? `:${diag.httpStatus}` : ''}` +
      `${diag.errorSnippet ? ` — ${diag.errorSnippet}` : ''}`,
    );
    this.name = 'DistillLlmError';
  }
}

export interface DistillCallDeps {
  signal?: AbortSignal;
  resolver: PipelineProviderResolver;
  resolveContext?: ResolveContext;
  getFallbackDefault?: () => FallbackDefault | null;
  /** Observability tap — receives the diag of every attempt (ok or not). */
  onDiag?: (diag: DistillDiag) => void;
  /** Test seam — replaces `callConfiguredChat`. */
  chatFn?: typeof callConfiguredChat;
}

/** Distill responses are small JSON arrays, but a thinking-capable model needs
 *  headroom; the live binding shipped with max_tokens:1200 which truncates. */
const MIN_DISTILL_MAX_TOKENS = 2000;
const DISTILL_TIMEOUT_MS = 45_000;
const SNIPPET_MAX = 300;

const snippet = (text: string): string =>
  text.replace(/\s+/g, ' ').trim().slice(0, SNIPPET_MAX);

/**
 * Resolve the `memory_extraction`/`distiller` binding and call it once,
 * retrying once on the general default when the BOUND provider fails at
 * runtime (an existing-but-broken binding never falls back on its own).
 * Throws {@link DistillLlmError} when no usable text came back.
 */
export async function callDistillLlm(
  deps: DistillCallDeps,
  messages: ChatMessage[],
): Promise<{ content: string; diag: DistillDiag }> {
  const fallbackDefault = deps.getFallbackDefault?.() ?? undefined;
  // resolveChain appends the general default as the last link, so a broken
  // bound provider (dead OAuth token, revoked key) fails over to it — and a
  // second CONFIGURED distiller binding now provides redundancy too.
  const chain = await deps.resolver
    .resolveChain('memory_extraction', 'distiller', deps.resolveContext ?? {}, fallbackDefault)
    .catch(() => [] as ResolvedBinding[]);
  if (chain.length === 0) {
    const diag: DistillDiag = {
      outcome: 'llm_error', rawChars: 0, latencyMs: 0,
      errorSnippet: 'no memory_extraction/distiller binding and no general default model',
    };
    deps.onDiag?.(diag);
    throw new DistillLlmError(diag);
  }

  const chatFn = deps.chatFn ?? callConfiguredChat;
  const runOne = (binding: ResolvedBinding): Promise<ChatCallResult> => {
    deps.signal?.throwIfAborted();
    const configured = Number((binding.config as Record<string, unknown>)?.max_tokens);
    const maxTokens = Math.max(Number.isFinite(configured) ? configured : 0, MIN_DISTILL_MAX_TOKENS);
    return chatFn(binding, messages, {
      disableThinking: suppressThinkingFor(binding),
      maxTokens,
      timeoutMs: DISTILL_TIMEOUT_MS,
      signal: deps.signal ? AbortSignal.any([deps.signal, AbortSignal.timeout(DISTILL_TIMEOUT_MS)]) : AbortSignal.timeout(DISTILL_TIMEOUT_MS),
    });
  };
  // The distiller has always gone straight to the next binding on failure
  // (no same-binding retry) — keep that by disabling per-binding retry.
  const { result, binding, failedOver } = await callChatWithFailover(chain, runOne, {
    signal: deps.signal,
    retry: { maxRetries: 0 },
    label: 'memory distiller',
    codePrefix: 'memory_distill',
  });
  const base = {
    providerId: binding?.provider.id,
    modelId: binding?.modelId,
    resolvedFrom: binding?.resolvedFrom,
  };
  const content = (result.content ?? '').trim();
  if (result.errorBody || !content) {
    const diag: DistillDiag = {
      ...base, outcome: 'llm_error', httpStatus: result.status,
      errorSnippet: snippet(result.errorBody || 'provider returned no text'),
      rawChars: content.length, latencyMs: Math.round(result.latencyMs),
      ...(failedOver ? { fallbackUsed: true } : {}),
    };
    deps.onDiag?.(diag);
    throw new DistillLlmError(diag);
  }
  const diag: DistillDiag = {
    ...base, outcome: 'ok', rawChars: content.length, latencyMs: Math.round(result.latencyMs),
    ...(failedOver ? { fallbackUsed: true } : {}),
  };
  deps.onDiag?.(diag);
  return { content, diag };
}

/**
 * When the parser yields zero candidates, decide whether the model genuinely
 * said "nothing durable" (a bare `[]` → no_facts) or misbehaved (prose, bad
 * JSON, malformed items → parse_empty, a retryable failure).
 */
export function classifyEmptyParse(text: string): 'no_facts' | 'parse_empty' {
  const cleaned = stripFences(text);
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start < 0 || end <= start) return 'parse_empty';
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    return Array.isArray(parsed) && parsed.length === 0 ? 'no_facts' : 'parse_empty';
  } catch {
    return 'parse_empty';
  }
}

/** Throw a typed parse failure unless the empty result was a genuine `[]`. */
export function assertParsableDistillResponse(content: string, parsedCount: number, diag: DistillDiag): void {
  if (parsedCount > 0) return;
  if (classifyEmptyParse(content) === 'no_facts') return;
  throw new DistillLlmError({ ...diag, outcome: 'parse_empty', errorSnippet: snippet(content) });
}

const VALID_CATEGORIES: ReadonlySet<SnapshotCategory> = new Set<SnapshotCategory>([
  'architecture', 'decision', 'convention', 'pattern', 'todo', 'note', 'gotcha', 'procedure',
  'user', 'feedback',
]);

/** Quality-over-quantity cap — a pass that "learns" 20 things learned none. */
export const MAX_CANDIDATES_PER_PASS = 6;

/**
 * Defensive parse of the LLM response into validated MemoryCandidates.
 * Drops malformed entries, clamps importance, validates category. Pure +
 * exported for unit testing. (Moved from distiller.ts — re-exported there.)
 */
export function parseMemoryCandidates(text: string): MemoryCandidate[] {
  const cleaned = stripFences(text);
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];

  const out: MemoryCandidate[] = [];
  for (const item of parsed) {
    if (out.length >= MAX_CANDIDATES_PER_PASS) break;
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const title = typeof o.title === 'string' ? o.title.trim() : '';
    const content = typeof o.content === 'string' ? o.content.trim() : '';
    if (!title || !content) continue;
    const category: SnapshotCategory = VALID_CATEGORIES.has(o.category as SnapshotCategory)
      ? (o.category as SnapshotCategory)
      : 'note';
    const importanceRaw = typeof o.importance === 'number' ? o.importance : 0.5;
    const importance = Math.max(0, Math.min(1, importanceRaw));
    const referencedFiles = Array.isArray(o.referencedFiles)
      ? o.referencedFiles.filter((f): f is string => typeof f === 'string')
      : undefined;
    out.push({ title, content, category, importance, referencedFiles });
  }
  return out;
}

function stripFences(text: string): string {
  return text
    .replace(/<think[\s\S]*?<\/think>/gi, '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
}

/**
 * LLM selective-recall filter — D1 (2/2) of the Claude-Code-gap plan.
 *
 * Claude Code's memory selector is an LLM JUDGMENT pass (not a vector tweak):
 * "return the memories that will CLEARLY be useful; if unsure, don't include
 * it; match on what the question IS ABOUT, not surface keyword overlap; be
 * especially conservative with user-profile memories." This filter applies that
 * pass over the candidates the structural retriever already surfaced.
 *
 * Mirrors the `LlmMemoryDistiller` pattern: resolve a `memory_recall`/`reranker`
 * binding via PipelineProviderResolver, call it, parse defensively. FAIL-OPEN
 * everywhere — no binding / LLM error / unparseable output all return the
 * candidates unchanged, so proactive memory injection is never broken by it.
 * Gated by the caller (CODER_MEMORY_LLM_FILTER); off → never constructed.
 */
import type { FallbackDefault, PipelineProviderResolver, ResolveContext } from '../pipelines/index.js';
import { callConfiguredChat } from '../quality/binding-chat.js';
import { callChatWithFailover } from '../quality/binding-failover.js';
import { suppressThinkingFor } from '../quality/chat-dispatcher.js';
import type { RetrievedMemory } from './retriever.js';

export interface LlmRecallFilterOptions {
  resolver: PipelineProviderResolver;
  resolveContext?: ResolveContext;
  /** Zero-config fallback consulted when no binding row resolves (lazy). */
  getFallbackDefault?: () => FallbackDefault | null;
  /** Skip the LLM (tests) — returns the candidates unchanged. */
  skipLlm?: boolean;
}

export class LlmRecallFilter {
  constructor(private readonly opts: LlmRecallFilterOptions) {}

  /**
   * Keep only the candidates clearly ABOUT the task. Fail-open: anything that
   * goes wrong returns `items` unchanged. With fewer than two candidates there
   * is nothing to discriminate, so the (paid) call is skipped.
   */
  async filter(taskText: string, items: RetrievedMemory[]): Promise<RetrievedMemory[]> {
    if (this.opts.skipLlm || items.length < 2) return items;
    // resolveChain lets a second configured reranker binding (or the general
    // default) serve when the primary is uncallable/down. The runner skips
    // OAuth-mismatched/misconfigured bindings and never throws — fail-open.
    const chain = await this.opts.resolver
      .resolveChain(
        'memory_recall',
        'reranker',
        this.opts.resolveContext ?? {},
        this.opts.getFallbackDefault?.() ?? undefined,
      )
      .catch(() => []);
    if (chain.length === 0) return items; // not configured → no filtering
    const messages = [
      { role: 'system' as const, content: SYSTEM_PROMPT },
      { role: 'user' as const, content: buildPrompt(taskText, items) },
    ];
    const { result } = await callChatWithFailover(
      chain,
      (b) =>
        callConfiguredChat(b, messages, {
          disableThinking: suppressThinkingFor(b),
          timeoutMs: 20_000,
          signal: AbortSignal.timeout(20_000),
        }),
      { label: 'memory recall filter', codePrefix: 'memory_recall', retry: { maxRetries: 0 } },
    );
    if (result.errorBody || !result.content.trim()) return items; // fail-open
    return decideKeep(items, parseKeepIds(result.content));
  }
}

const SYSTEM_PROMPT = `You decide which of the candidate project memories are CLEARLY useful for the agent's current task. Be strict.

Rules:
- Keep a memory only if it would clearly help with THIS task. If unsure, drop it.
- Match on what the task IS ABOUT, not surface keyword overlap (a memory about "DB performance" is NOT useful just because the task mentions "performance").
- Be especially conservative with broad user-profile / project-overview memories — keep them only when directly applicable.
- Keep at most 5.

Respond with ONLY a JSON array of the ids to KEEP, most useful first. Empty array if none are clearly useful. Example: ["3","1"]`;

function buildPrompt(taskText: string, items: RetrievedMemory[]): string {
  const list = items
    .map((m) => `- id ${m.id}: ${m.title} — ${m.content.replace(/\s*\n\s*/g, ' ').slice(0, 300)}`)
    .join('\n');
  return `Task:\n${taskText.trim()}\n\nCandidate memories:\n${list}\n\nReturn a JSON array of the ids to KEEP (clearly useful for THIS task; empty array if none).`;
}

/**
 * Pure: extract the JSON array of ids from the model output. Returns null when
 * no parseable array is present (caller treats as fail-open). Exported for tests.
 */
export function parseKeepIds(text: string): string[] | null {
  const cleaned = text
    .replace(/<think[\s\S]*?<\/think>/gi, '')
    .replace(/```(?:json)?/gi, '')
    .trim();
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    if (!Array.isArray(parsed)) return null;
    return parsed.map((x) => String(x).trim()).filter((s) => s.length > 0);
  } catch {
    return null;
  }
}

/**
 * Pure decision: apply the parsed keep-list to the candidates with fail-safe
 * branches. Exported for tests.
 *   - keepIds null (unparseable)        → keep ALL (fail-open)
 *   - keepIds []   (model said "none")  → keep NONE (CC's "return empty list")
 *   - some ids match                    → keep that subset
 *   - ids given but NONE match          → keep ALL (model likely confused)
 */
export function decideKeep(items: RetrievedMemory[], keepIds: string[] | null): RetrievedMemory[] {
  if (keepIds === null) return items;
  if (keepIds.length === 0) return [];
  const keep = new Set(keepIds);
  const filtered = items.filter((m) => keep.has(m.id));
  return filtered.length > 0 ? filtered : items;
}

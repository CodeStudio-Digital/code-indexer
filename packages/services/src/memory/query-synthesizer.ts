/**
 * LLM memory-query synthesizer — turns a META message ("continue", "reanalise
 * tudo que fez") plus the recent conversation tail into ONE sharp search query
 * describing the task actually in progress, so proactive Mem C recall stops
 * missing on task-less continuations.
 *
 * Mirrors the `LlmRecallFilter` pattern: resolve a `memory_query`/`query_writer`
 * binding via PipelineProviderResolver, call it, parse defensively. Everything
 * FAILS to `null` — no binding, LLM error, empty/unparseable output — so the
 * caller falls back to the pure `walkBackTaskText` heuristic and memory recall
 * is never blocked by this. Gated by the caller (only invoked for meta messages).
 *
 * Deliberately NO `getFallbackDefault`: an unconfigured `memory_query` binding
 * means "use the heuristic", never "spend a general-default call on every meta
 * turn" — this call sits on the turn's critical path (short 8s budget).
 */
import type { PipelineProviderResolver, ResolveContext } from '../pipelines/index.js';
import { callConfiguredChat } from '../quality/binding-chat.js';
import { callChatWithFailover } from '../quality/binding-failover.js';
import { suppressThinkingFor } from '../quality/chat-dispatcher.js';

/** Structural mirror of code-agent's `ConversationTail` (rides the worker bridge). */
export interface QueryTailMessage {
  role: 'user' | 'assistant';
  text: string;
}
export type ConversationTail = ReadonlyArray<QueryTailMessage>;

export interface LlmMemoryQuerySynthesizerOptions {
  resolver: PipelineProviderResolver;
  resolveContext?: ResolveContext;
  /** Skip the LLM (tests) — returns null so the caller uses the heuristic. */
  skipLlm?: boolean;
}

export class LlmMemoryQuerySynthesizer {
  constructor(private readonly opts: LlmMemoryQuerySynthesizerOptions) {}

  /**
   * Write a short search query from the conversation tail. Returns null on any
   * trouble (no binding / error / empty) so the caller uses the heuristic.
   */
  async synthesize(tail: ConversationTail): Promise<string | null> {
    if (this.opts.skipLlm || tail.length === 0) return null;
    // resolveChain lets a second configured binding serve when the primary is
    // uncallable; NO general-default fallback here (unconfigured → heuristic).
    const chain = await this.opts.resolver
      .resolveChain('memory_query', 'query_writer', this.opts.resolveContext ?? {}, undefined)
      .catch(() => []);
    if (chain.length === 0) return null; // not configured → heuristic
    const messages = [
      { role: 'system' as const, content: SYSTEM_PROMPT },
      { role: 'user' as const, content: buildPrompt(tail) },
    ];
    try {
      const { result } = await callChatWithFailover(
        chain,
        (b) =>
          callConfiguredChat(b, messages, {
            disableThinking: suppressThinkingFor(b),
            // Short budget: this call blocks the START of the turn, unlike the
            // recall filter (which runs after candidates are already fetched).
            timeoutMs: 8_000,
            signal: AbortSignal.timeout(8_000),
          }),
        { label: 'memory query synthesizer', codePrefix: 'memory_query', retry: { maxRetries: 0 } },
      );
      if (result.errorBody || !result.content.trim()) return null; // fail → heuristic
      return parseQuery(result.content);
    } catch {
      return null; // fail → heuristic
    }
  }
}

const SYSTEM_PROMPT = `You write ONE short search query for a code-memory database.

The user's latest message may be a meta/continuation ("continue", "do it again", "reanalise tudo") that names no concrete task. Read the recent conversation and infer the ACTUAL task in progress.

Rules:
- Output ONE line: a concise search query (≤ 15 words) describing the task/topic.
- Use concrete nouns from the conversation (files, features, symbols, errors). No filler.
- Do NOT answer the task, explain, or add quotes/labels — output only the query.
- If you truly cannot tell what the task is, output an empty line.`;

function buildPrompt(tail: ConversationTail): string {
  const convo = tail
    .map((m) => `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.text.replace(/\s*\n\s*/g, ' ')}`)
    .join('\n');
  return `Recent conversation:\n${convo}\n\nSearch query for the task in progress:`;
}

/**
 * Pure: extract the query from the model output — strip think-tags/fences, take
 * the first non-empty line, unquote, cap length. Null when empty (fail-open).
 * Exported for tests.
 */
export function parseQuery(text: string): string | null {
  const cleaned = text
    .replace(/<think[\s\S]*?<\/think>/gi, '')
    // Also drop an UNCLOSED / truncated `<think>` block to EOF — a reasoning
    // model cut off at a tiny max_tokens leaks its chain-of-thought with no
    // closing tag, which must NOT become the search query (worse than the
    // heuristic). Stripping it to empty makes parse fail-open to null.
    .replace(/<think[\s\S]*$/i, '')
    // Strip fence MARKERS only (with an optional language tag) — keep the code
    // between them; removing the whole block would drop the query itself.
    .replace(/```(?:[a-z]+)?/gi, '')
    .trim();
  const firstLine = cleaned.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
  if (!firstLine) return null;
  // Drop a leading "Query:"-style label and surrounding quotes.
  const unlabeled = firstLine.replace(/^(query|search|task)\s*[:\-]\s*/i, '').trim();
  const unquoted = unlabeled.replace(/^["'`]+|["'`]+$/g, '').trim();
  if (!unquoted) return null;
  return unquoted.slice(0, 200);
}

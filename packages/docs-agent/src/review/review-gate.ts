/**
 * review-gate — the "strong model reviews the cheap model" quality gate.
 *
 * The DocsAgent drives retrieval with the strong `scorer_llm` (GLM-5.1) but
 * renders the prose with the cheaper `classifier` (GLM-5) via docs_synthesize.
 * Before the answer leaves the agent, this gate runs ONE strong-model pass
 * that checks each claim against the chunks the agent actually cited — a
 * FIDELITY check, not a rewrite. It catches the failure mode the loop can't
 * see itself: confident prose that drifts past what the sources support.
 *
 * Design:
 *   - Reuses `pickChatFn(binding)` — the same dispatcher the reranker and
 *     synthesizer use — so no new provider plumbing.
 *   - Degrades to `verdict='pass', ran=false` on reviewer failure. Explicit
 *     cancellation propagates so the session cannot publish a cancelled answer.
 *   - One call per research run (NOT per turn). Disable via DOCS_REVIEW_GATE=0.
 *
 * No cache: each run produces unique markdown, so a content-keyed cache
 * would almost never hit — deliberately omitted rather than add dead weight.
 */
import { pickChatFn } from '@mcp/services/quality/chat-dispatcher.js';
import type { ResolvedBinding } from '@mcp/services/pipelines/index.js';

export type ReviewConfidence = 'high' | 'medium' | 'low';

export interface ReviewChunk {
  chunk_id: number;
  heading_path: string | null;
  content: string;
}

export interface ReviewInput {
  signal?: AbortSignal;
  query: string;
  markdown: string;
  chunks: ReviewChunk[];
  binding: ResolvedBinding;
  /** Sub-questions the agent committed to via docs_plan (coverage check). */
  subQuestions?: string[];
}

export interface ReviewResult {
  verdict: 'pass' | 'repair';
  /** Provided only when verdict='repair' — the corrected/qualified markdown. */
  repairedMarkdown?: string;
  /** Claims the reviewer found unsupported by the cited chunks. */
  unsupportedClaims: string[];
  /** Sub-questions the answer left uncovered (when a plan was supplied). */
  uncoveredSubQuestions: string[];
  /** False on every degraded path — the gate didn't actually run. */
  ran: boolean;
  /** Reviewer LLM token usage, when the adapter reports it. */
  usage?: { input_tokens: number; output_tokens: number };
}

/** Max chars of each chunk sent to the reviewer (cost control). */
const MAX_CHUNK_CHARS = 1500;

const PASS: ReviewResult = {
  verdict: 'pass',
  unsupportedClaims: [],
  uncoveredSubQuestions: [],
  ran: false,
};

export async function reviewAnswer(input: ReviewInput): Promise<ReviewResult> {
  input.signal?.throwIfAborted();
  if (!input.markdown.trim() || input.chunks.length === 0) return PASS;

  const chat = pickChatFn(input.binding);
  let response: { content: string; usage?: unknown };
  try {
    response = await chat(input.binding, [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildPrompt(input) },
    ], { signal: input.signal });
    input.signal?.throwIfAborted();
  } catch {
    input.signal?.throwIfAborted();
    return PASS;
  }

  const parsed = parseReview(response.content);
  if (!parsed) return PASS;
  return { ...parsed, ran: true, usage: extractUsage(response) };
}

/**
 * Fold a review verdict into the final answer: on 'repair', swap in the
 * corrected markdown (falling back to the original if the reviewer didn't
 * supply one), downgrade confidence one notch, and append a transparent
 * caveat. On 'pass' (or a degraded run) the answer is returned untouched.
 */
export function applyReview(
  markdown: string,
  confidence: ReviewConfidence,
  review: ReviewResult,
): { markdown: string; confidence: ReviewConfidence; reviewNote: string | null } {
  if (!review.ran || review.verdict === 'pass') {
    return { markdown, confidence, reviewNote: null };
  }
  const repaired = review.repairedMarkdown?.trim() || markdown;
  const note = buildReviewNote(review);
  const withNote = note ? `${repaired}\n\n${note}` : repaired;
  return { markdown: withNote, confidence: downgrade(confidence), reviewNote: note };
}

// ─── Helpers ────────────────────────────────────────────────────────

function downgrade(c: ReviewConfidence): ReviewConfidence {
  return c === 'high' ? 'medium' : c === 'medium' ? 'low' : 'low';
}

function buildReviewNote(review: ReviewResult): string | null {
  const parts: string[] = [];
  if (review.unsupportedClaims.length > 0) {
    parts.push(`removed/qualified ${review.unsupportedClaims.length} claim(s) not supported by the cited docs`);
  }
  if (review.uncoveredSubQuestions.length > 0) {
    parts.push(`${review.uncoveredSubQuestions.length} sub-question(s) left uncovered`);
  }
  if (parts.length === 0) return null;
  return `_(Fidelity review: ${parts.join('; ')}. Confidence downgraded.)_`;
}

function extractUsage(response: { usage?: unknown }): { input_tokens: number; output_tokens: number } | undefined {
  if (!response.usage || typeof response.usage !== 'object') return undefined;
  const u = response.usage as Record<string, unknown>;
  const input = Number(u.input_tokens ?? u.prompt_tokens ?? 0);
  const output = Number(u.output_tokens ?? u.completion_tokens ?? 0);
  if (!Number.isFinite(input) && !Number.isFinite(output)) return undefined;
  return {
    input_tokens: Number.isFinite(input) ? input : 0,
    output_tokens: Number.isFinite(output) ? output : 0,
  };
}

const SYSTEM_PROMPT = `You are a strict fidelity reviewer for documentation answers.

You receive a developer's QUERY, an ANSWER (markdown with [^N] footnotes), and the SOURCE PASSAGES the answer cited. Optionally a list of SUB-QUESTIONS the answer was meant to cover.

Your ONLY job is to check that every factual claim, API name, version number, and code detail in the ANSWER is supported by the SOURCE PASSAGES. You are NOT improving style.

Rules:
- A claim is "unsupported" if no cited passage states it (or it contradicts them). Reasonable paraphrase IS supported.
- If you find unsupported claims, set verdict="repair" and return repairedMarkdown that REMOVES or explicitly QUALIFIES them (e.g. "the docs don't specify X"). Keep everything that IS supported. Preserve the [^N] footnotes.
- If a sub-question has no supporting passage, list it in uncoveredSubQuestions (do not invent an answer).
- If everything checks out, set verdict="pass".

Respond ONLY with a JSON object, no prose:
{"verdict":"pass"|"repair","unsupportedClaims":[],"uncoveredSubQuestions":[],"repairedMarkdown":"..."}
Omit repairedMarkdown when verdict="pass".`;

function buildPrompt(input: ReviewInput): string {
  const passages = input.chunks
    .map((c, i) => {
      const body = c.content.length > MAX_CHUNK_CHARS ? c.content.slice(0, MAX_CHUNK_CHARS) + '…' : c.content;
      return `### Passage ${i + 1} (chunk_id=${c.chunk_id}) — ${c.heading_path ?? '(untitled)'}\n${body}`;
    })
    .join('\n\n');
  const subs = input.subQuestions && input.subQuestions.length > 0
    ? `\n\nSUB-QUESTIONS:\n${input.subQuestions.map((s, i) => `${i + 1}. ${s}`).join('\n')}`
    : '';
  return `QUERY: "${input.query}"${subs}\n\nANSWER:\n${input.markdown}\n\nSOURCE PASSAGES:\n${passages}\n\nReturn the JSON verdict.`;
}

function parseReview(text: string): Omit<ReviewResult, 'ran' | 'usage'> | null {
  const cleaned = text
    .replace(/<think[\s\S]*?<\/think>/gi, '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const o = parsed as Record<string, unknown>;
  const verdict = o.verdict === 'repair' ? 'repair' : 'pass';
  return {
    verdict,
    repairedMarkdown: typeof o.repairedMarkdown === 'string' ? o.repairedMarkdown : undefined,
    unsupportedClaims: toStringArray(o.unsupportedClaims),
    uncoveredSubQuestions: toStringArray(o.uncoveredSubQuestions),
  };
}

function toStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.filter((x): x is string => typeof x === 'string' && x.trim().length > 0).map((x) => x.trim());
}

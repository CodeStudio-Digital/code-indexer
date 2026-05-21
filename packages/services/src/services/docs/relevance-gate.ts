/**
 * Relevance gate — decides whether a fetched page is "real documentation"
 * vs noise (nav-only stubs, 404 fallback pages, login walls, etc.).
 *
 * Two-stage filter:
 *   1. `heuristicAccepts(page)` — free, deterministic checks (length,
 *      noindex meta, content-type). Most junk pages die here.
 *   2. LLM batched call — survivors are bundled into a single chat call
 *      that returns a JSON array of booleans. Provider/model is resolved
 *      via `pipeline_provider_bindings` under
 *      `pipeline_name='doc_ingest', binding_role='classifier'`.
 *
 * Batching cuts cost ~5-10× vs one call per page.
 */
import type { PipelineProviderResolver } from '../../pipelines/index.js';
import { pickChatFn } from '../../quality/chat-dispatcher.js';
import type { RawPage } from './types.js';

const DEFAULT_BATCH_SIZE = 8;
const MIN_BODY_CHARS = 500;

export interface RelevanceGateOptions {
  resolver: PipelineProviderResolver;
  resolveContext?: { sessionId?: number; companySessionId?: number; templateId?: number };
  /** Override the per-call batch size (default 8). */
  batchSize?: number;
  /** Skip the LLM call entirely — useful for tests. Pages that pass heuristics auto-accept. */
  skipLlm?: boolean;
}

export interface GateVerdict {
  accept: boolean;
  reason: string;
}

/**
 * Cheap deterministic filter that runs BEFORE the LLM. Removes the most
 * obvious junk so we don't pay for it. Returns `false` (drop) only when
 * we're highly confident — borderline cases proceed to the LLM gate.
 */
export function heuristicAccepts(page: RawPage): GateVerdict {
  const md = page.markdown ?? '';
  if (md.length < MIN_BODY_CHARS) {
    return { accept: false, reason: `body too short (${md.length} chars)` };
  }
  // Pages with no headings AND no paragraphs are almost certainly nav-only.
  if (!/[#\n]{2}/.test(md) && md.split(/\s+/).length < 100) {
    return { accept: false, reason: 'no structure (likely nav stub)' };
  }
  // Login/error pages fingerprint.
  const lower = md.toLowerCase();
  if (/(sign in|log in|404|not found|access denied)/i.test(lower) && md.length < 1200) {
    return { accept: false, reason: 'login or error page' };
  }
  return { accept: true, reason: 'passes heuristic' };
}

/**
 * Apply the LLM gate to a list of pages. Returns one verdict per input,
 * in the same order. Heuristically-rejected pages get a verdict immediately
 * without hitting the LLM; the rest are batched.
 *
 * If the LLM binding is missing OR the LLM call errors, the surviving
 * pages are returned with `accept=true` (degraded mode — better to over-
 * include than break ingestion on a misconfigured admin panel).
 */
export async function gatePages(
  pages: RawPage[],
  opts: RelevanceGateOptions,
): Promise<GateVerdict[]> {
  const verdicts: GateVerdict[] = pages.map(heuristicAccepts);
  if (opts.skipLlm) return verdicts;

  // Indices of pages that survived heuristics → batched LLM judgment.
  const queue: number[] = [];
  for (let i = 0; i < pages.length; i++) {
    if (verdicts[i]!.accept) queue.push(i);
  }
  if (queue.length === 0) return verdicts;

  const binding = await opts.resolver.resolveOrNull(
    'doc_ingest',
    'classifier',
    opts.resolveContext ?? {},
  );
  if (!binding) {
    // Degrade gracefully — heuristic-accepted pages all pass.
    for (const idx of queue) {
      verdicts[idx] = { accept: true, reason: 'gate skipped (no binding configured)' };
    }
    return verdicts;
  }

  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const chat = pickChatFn(binding);

  for (let i = 0; i < queue.length; i += batchSize) {
    const batchIdx = queue.slice(i, i + batchSize);
    const batchPages = batchIdx.map((idx) => pages[idx]!);
    let parsed: GateVerdict[] | null = null;
    try {
      const result = await chat(binding, [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildBatchPrompt(batchPages) },
      ]);
      parsed = parseBatchResponse(result.content, batchPages.length);
    } catch (err) {
      // Network/timeout: degrade to accept-all for this batch.
      const msg = err instanceof Error ? err.message : String(err);
      for (const idx of batchIdx) {
        verdicts[idx] = { accept: true, reason: `gate error: ${msg.slice(0, 80)}` };
      }
      continue;
    }
    if (!parsed) {
      for (const idx of batchIdx) {
        verdicts[idx] = { accept: true, reason: 'gate response unparseable (accepted by default)' };
      }
      continue;
    }
    for (let j = 0; j < batchIdx.length; j++) {
      const idx = batchIdx[j]!;
      verdicts[idx] = parsed[j] ?? { accept: true, reason: 'missing verdict (accepted by default)' };
    }
  }

  return verdicts;
}

const SYSTEM_PROMPT = `You are a documentation triage classifier. You receive a batch of web pages and decide which contain real technical documentation (API references, guides, tutorials, conceptual explanations).

Reject pages that are mostly navigation, marketing copy, login forms, search pages, error pages, blog post lists, table-of-contents stubs, or empty boilerplate.

Respond ONLY with a JSON array, one object per input in the same order, of the shape:
[{"keep": true, "reason": "<one short phrase>"}, ...]

Do not include any other text.`;

interface ParsedVerdict { keep: boolean; reason?: string }

function buildBatchPrompt(pages: RawPage[]): string {
  const sections = pages.map((p, i) => {
    const head = `### Page ${i + 1}\nURL: ${p.uri}\nTitle: ${p.title ?? '(none)'}`;
    // Trim each page to keep prompt size sane (~1.5k chars × N).
    const body = (p.markdown ?? '').slice(0, 1500);
    return `${head}\n---\n${body}\n`;
  });
  return `Classify each of the following ${pages.length} pages:\n\n${sections.join('\n')}`;
}

function parseBatchResponse(text: string, expectedLength: number): GateVerdict[] | null {
  const cleaned = stripFences(text);
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  const slice = cleaned.slice(start, end + 1);
  let parsed: unknown;
  try {
    parsed = JSON.parse(slice);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const verdicts: GateVerdict[] = [];
  for (let i = 0; i < expectedLength; i++) {
    const item = parsed[i] as ParsedVerdict | undefined;
    if (item && typeof item.keep === 'boolean') {
      verdicts.push({
        accept: item.keep,
        reason: typeof item.reason === 'string' ? item.reason.slice(0, 200) : 'llm verdict',
      });
    } else {
      verdicts.push({ accept: true, reason: 'missing verdict (accepted)' });
    }
  }
  return verdicts;
}

function stripFences(text: string): string {
  return text
    .replace(/<think[\s\S]*?<\/think>/gi, '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
}

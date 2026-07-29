/**
 * Per-chunk LLM enrichment — produces a 1-2 sentence summary and a short
 * list of concept tags for each chunk. The enriched fields land on
 * `doc_chunks.summary` and `doc_chunks.concepts` and feed both the FTS5
 * index (better recall on conceptual queries) and the agent-facing result
 * formatter (snippets show the summary as a header).
 *
 * Provider/model is resolved via `pipeline_provider_bindings` under
 * `pipeline_name='doc_ingest', binding_role='scorer_llm'`. Missing binding
 * degrades gracefully — chunks land without enrichment and the indexer
 * continues. The dashboard surfaces a warning when this happens.
 */
import type { PipelineProviderResolver } from '../../pipelines/index.js';
import { pickChatFn } from '../../quality/chat-dispatcher.js';

const DEFAULT_CONCURRENCY = 4;

export interface EnrichmentInput {
  chunk_index: number;
  heading_path: string;
  content: string;
}

export interface EnrichmentOutput {
  chunk_index: number;
  summary: string | null;
  concepts: string[];
  error?: string;
}

export interface EnricherOptions {
  resolver: PipelineProviderResolver;
  resolveContext?: { sessionId?: string; companySessionId?: string; templateId?: number };
  concurrency?: number;
  /** Optional progress callback fired after each chunk completes. */
  onProgress?: (done: number, total: number) => void;
  /** Skip LLM (tests). Returns inputs with null enrichment. */
  skipLlm?: boolean;
}

/**
 * Enrich a batch of chunks. Returns one output per input. Order preserved.
 *
 * Errors per chunk are captured in `output.error` so callers can decide
 * whether to retry or accept partial enrichment. The function as a whole
 * never throws unless `resolver.resolve` throws — even then we degrade
 * to all-null outputs.
 */
export async function enrichChunks(
  inputs: EnrichmentInput[],
  opts: EnricherOptions,
): Promise<EnrichmentOutput[]> {
  if (inputs.length === 0) return [];
  if (opts.skipLlm) {
    return inputs.map((input) => ({
      chunk_index: input.chunk_index,
      summary: null,
      concepts: [],
    }));
  }

  const binding = await opts.resolver.resolveOrNull(
    'doc_ingest',
    'scorer_llm',
    opts.resolveContext ?? {},
  );
  if (!binding) {
    return inputs.map((input) => ({
      chunk_index: input.chunk_index,
      summary: null,
      concepts: [],
      error: 'no enricher binding configured',
    }));
  }

  const chat = pickChatFn(binding);
  const concurrency = Math.max(1, opts.concurrency ?? DEFAULT_CONCURRENCY);
  const outputs: EnrichmentOutput[] = new Array(inputs.length);
  let done = 0;
  let cursor = 0;

  const runOne = async () => {
    while (cursor < inputs.length) {
      const myIdx = cursor++;
      const input = inputs[myIdx]!;
      try {
        const result = await chat(binding, [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildPrompt(input) },
        ]);
        const parsed = parseEnrichment(result.content);
        outputs[myIdx] = {
          chunk_index: input.chunk_index,
          summary: parsed.summary,
          concepts: parsed.concepts,
        };
      } catch (err) {
        outputs[myIdx] = {
          chunk_index: input.chunk_index,
          summary: null,
          concepts: [],
          error: err instanceof Error ? err.message : String(err),
        };
      } finally {
        done++;
        opts.onProgress?.(done, inputs.length);
      }
    }
  };

  const workers = Array.from({ length: Math.min(concurrency, inputs.length) }, () => runOne());
  await Promise.all(workers);
  return outputs;
}

/**
 * Cost-bounded enrichment used by progressive ingestion: up to eight chunks
 * share one LLM request. The legacy per-chunk function remains for callers
 * that need isolated retries.
 */
export async function enrichChunksBatched(
  inputs: EnrichmentInput[],
  opts: EnricherOptions & { batchSize?: number },
): Promise<EnrichmentOutput[]> {
  if (inputs.length === 0) return [];
  if (opts.skipLlm) return enrichChunks(inputs, opts);
  const binding = await opts.resolver.resolveOrNull('doc_ingest', 'scorer_llm', opts.resolveContext ?? {});
  if (!binding) return inputs.map((input) => ({ chunk_index: input.chunk_index, summary: null, concepts: [], error: 'no enricher binding configured' }));
  const chat = pickChatFn(binding);
  const batchSize = Math.max(1, Math.min(8, opts.batchSize ?? 8));
  const outputs: EnrichmentOutput[] = [];
  let done = 0;
  for (let offset = 0; offset < inputs.length; offset += batchSize) {
    const batch = inputs.slice(offset, offset + batchSize);
    try {
      const result = await chat(binding, [
        { role: 'system', content: BATCH_SYSTEM_PROMPT },
        { role: 'user', content: buildBatchEnrichmentPrompt(batch) },
      ]);
      const parsed = parseBatchEnrichment(result.content, batch.length);
      for (let index = 0; index < batch.length; index++) {
        const item = batch[index]!;
        const value = parsed?.[index];
        outputs.push({
          chunk_index: item.chunk_index,
          summary: value?.summary ?? null,
          concepts: value?.concepts ?? [],
          ...(!value ? { error: 'unparseable batched enrichment' } : {}),
        });
        done++;
        opts.onProgress?.(done, inputs.length);
      }
    } catch (error) {
      for (const item of batch) {
        outputs.push({ chunk_index: item.chunk_index, summary: null, concepts: [], error: error instanceof Error ? error.message : String(error) });
        done++;
        opts.onProgress?.(done, inputs.length);
      }
    }
  }
  return outputs;
}

const SYSTEM_PROMPT = `You analyze a single passage from technical documentation and produce two things:

1. A 1-2 sentence "summary" capturing what the passage covers (factual, no marketing language).
2. A list of 3-8 "concepts" — short noun phrases that another developer would type when searching for this passage (e.g. ["physics raycast", "collider layers", "ignore self"]).

Respond ONLY with a JSON object:
{"summary": "...", "concepts": ["...", "..."]}

Keep it tight. No prose around the JSON.`;

const BATCH_SYSTEM_PROMPT = `You enrich technical-documentation passages for search. Return ONLY a JSON array in input order. Each item must be {"summary":"1-2 factual sentences","concepts":["3-8 short search phrases"]}. Never invent behavior not present in its passage.`;

function buildBatchEnrichmentPrompt(inputs: EnrichmentInput[]): string {
  return inputs.map((input, index) =>
    `### Passage ${index + 1}: ${input.heading_path}\n${input.content.slice(0, 3_000)}`,
  ).join('\n\n---\n\n');
}

function parseBatchEnrichment(text: string, expected: number): ParsedEnrichment[] | null {
  const cleaned = stripFences(text);
  const start = cleaned.indexOf('[');
  const end = cleaned.lastIndexOf(']');
  if (start < 0 || end <= start) return null;
  try {
    const parsed = JSON.parse(cleaned.slice(start, end + 1));
    if (!Array.isArray(parsed)) return null;
    return Array.from({ length: expected }, (_, index) => {
      const item = parsed[index];
      return parseEnrichment(JSON.stringify(item ?? {}));
    });
  } catch {
    return null;
  }
}

function buildPrompt(input: EnrichmentInput): string {
  return `### ${input.heading_path}\n\n${input.content.slice(0, 4000)}`;
}

interface ParsedEnrichment { summary: string | null; concepts: string[] }

function parseEnrichment(text: string): ParsedEnrichment {
  const cleaned = stripFences(text);
  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start < 0 || end <= start) return { summary: null, concepts: [] };
  let parsed: unknown;
  try { parsed = JSON.parse(cleaned.slice(start, end + 1)); }
  catch { return { summary: null, concepts: [] }; }
  if (!parsed || typeof parsed !== 'object') return { summary: null, concepts: [] };
  const summary = (parsed as { summary?: unknown }).summary;
  const rawConcepts = (parsed as { concepts?: unknown }).concepts;
  return {
    summary: typeof summary === 'string' ? summary.slice(0, 600).trim() : null,
    concepts: Array.isArray(rawConcepts)
      ? rawConcepts
          .filter((c): c is string => typeof c === 'string')
          .map((c) => c.trim())
          .filter((c) => c.length > 0 && c.length <= 80)
          .slice(0, 8)
      : [],
  };
}

function stripFences(text: string): string {
  return text
    .replace(/<think[\s\S]*?<\/think>/gi, '')
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/```\s*$/, '')
    .trim();
}

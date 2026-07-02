/**
 * Failure distiller — turns a session's errors-and-fixes into durable `gotcha`
 * lessons ("Symptom → Root cause → Fix → Avoid") so a future agent on this
 * repo stops repeating the same mistakes. The thesis core: failures are
 * assets when tied to their resolution.
 *
 * Sibling of {@link LlmMemoryDistiller}: same provider binding
 * (`memory_extraction` / `distiller`) via {@link callDistillLlm} (throws a
 * typed `DistillLlmError` on transport/parse failure; [] only on a genuine
 * "no lesson"), and it REUSES `parseMemoryCandidates` — one defensive parser.
 * It differs only in prompt + that it FORCES `category:'gotcha'` regardless of
 * what the model emits. Plugs into the generic `MemoryExtractor` (dedup +
 * importance floors + persist) unchanged.
 */
import type { FallbackDefault, PipelineProviderResolver, ResolveContext } from '../pipelines/index.js';
import {
  assertParsableDistillResponse,
  callDistillLlm,
  parseMemoryCandidates,
  type DistillDiag,
} from './distill-call.js';
import type { MemoryCandidate, MemoryDistiller, SessionMemoryInput } from './extractor.js';

export interface FailureDistillerOptions {
  resolver: PipelineProviderResolver;
  resolveContext?: ResolveContext;
  /** Zero-config fallback consulted when no binding row resolves (lazy). */
  getFallbackDefault?: () => FallbackDefault | null;
  /** Observability tap — receives the diag of every LLM attempt. */
  onDiag?: (diag: DistillDiag) => void;
  /** Skip the LLM (tests) — returns []. */
  skipLlm?: boolean;
}

export class FailureDistiller implements MemoryDistiller {
  constructor(private readonly opts: FailureDistillerOptions) {}

  async distill(input: SessionMemoryInput): Promise<MemoryCandidate[]> {
    if (this.opts.skipLlm) return [];
    const errors = (input.errorsAndFixes ?? []).map((e) => e.trim()).filter(Boolean);
    if (errors.length === 0) return []; // nothing to learn from → cheap exit, no LLM call

    const { content, diag } = await callDistillLlm(this.opts, [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildPrompt(input, errors) },
    ]);
    // This distiller mints lessons only — force the category so a model that
    // forgets/mislabels it still lands as a retrievable gotcha.
    const candidates = parseMemoryCandidates(content).map((c) => ({ ...c, category: 'gotcha' as const }));
    assertParsableDistillResponse(content, candidates.length, diag);
    return candidates;
  }
}

const SYSTEM_PROMPT = `You extract durable LESSONS from failures hit during a coding session — so a future agent on THIS repo avoids repeating them.

Capture ONLY failures that carry a reusable lesson:
- a real error/bug, its root cause, and the fix that worked
- a non-obvious constraint or footgun the failure revealed (ABI mismatch, ordering requirement, config trap)

Do NOT capture transient noise: typos fixed immediately, flaky network, one-off environment hiccups, or anything without a durable takeaway.

For each lesson return:
- title: the symptom, short and searchable (e.g. "better-sqlite3 ERR_DLOPEN_FAILED in tests")
- content: "Symptom: … Root cause: … Fix: … Avoid: …" — 1-4 sentences, self-contained
- importance: 0..1 — proportional to the time lost and how likely the failure is to recur
- referencedFiles: file paths involved, if any

Respond ONLY with a JSON array, no prose. Empty array if no durable lesson:
[{"title":"…","content":"Symptom: … Root cause: … Fix: … Avoid: …","importance":0.7,"referencedFiles":["src/x.ts"]}]`;

function buildPrompt(input: SessionMemoryInput, errors: string[]): string {
  const parts: string[] = [];
  if (input.primaryRequest) parts.push(`Task: ${input.primaryRequest}`);
  parts.push(`Errors hit and how they were resolved:\n${errors.map((e) => `- ${e}`).join('\n')}`);
  if (input.filesTouched?.length) parts.push(`Files touched: ${input.filesTouched.slice(0, 30).join(', ')}`);
  return `Extract durable lessons from the failures in this session.\n\n${parts.join('\n\n')}\n\nRespond with a JSON array (empty if no durable lesson).`;
}

/**
 * LLM-backed MemoryDistiller — turns a coding-session signal into durable
 * project-memory candidates. Resolution + transport live in
 * {@link callDistillLlm} (binding-chat routing: OAuth kinds get the full
 * coder client, so google-oauth/chatgpt bindings actually work).
 *
 * Posture: extract only DURABLE facts (decisions, conventions, gotchas,
 * architecture) — never transient task state. A transport/parse failure
 * THROWS `DistillLlmError` (the orchestrator logs it as a retryable error);
 * a genuine "nothing durable" returns [].
 */
import type { FallbackDefault, PipelineProviderResolver, ResolveContext } from '../pipelines/index.js';
import {
  assertParsableDistillResponse,
  callDistillLlm,
  parseMemoryCandidates,
  type DistillDiag,
} from './distill-call.js';
import type { MemoryCandidate, MemoryDistiller, SessionMemoryInput } from './extractor.js';

// Re-exported for the existing consumers (failure/procedure distillers, tests).
export { parseMemoryCandidates } from './distill-call.js';

export interface LlmMemoryDistillerOptions {
  resolver: PipelineProviderResolver;
  resolveContext?: ResolveContext;
  /** Zero-config fallback consulted when no binding row resolves. Lazy —
   *  the operator can change the general default model at runtime. */
  getFallbackDefault?: () => FallbackDefault | null;
  /** Observability tap — receives the diag of every LLM attempt. */
  onDiag?: (diag: DistillDiag) => void;
  /** Skip the LLM (tests) — returns []. */
  skipLlm?: boolean;
}

export class LlmMemoryDistiller implements MemoryDistiller {
  constructor(private readonly opts: LlmMemoryDistillerOptions) {}

  async distill(input: SessionMemoryInput): Promise<MemoryCandidate[]> {
    if (this.opts.skipLlm) return [];
    const { content, diag } = await callDistillLlm(this.opts, [
      { role: 'system', content: SYSTEM_PROMPT },
      { role: 'user', content: buildPrompt(input) },
    ]);
    const candidates = parseMemoryCandidates(content);
    assertParsableDistillResponse(content, candidates.length, diag);
    return candidates;
  }
}

/**
 * One-shot diagnostic pass (memory dry-run route): same binding, same prompt,
 * but returns the RAW LLM text + parsed candidates WITHOUT persisting.
 * Throws `DistillLlmError` (carrying its diag) on transport failure —
 * exactly what the operator needs to see why a pass came back empty.
 */
export async function runDistillOnce(
  opts: Pick<LlmMemoryDistillerOptions, 'resolver' | 'resolveContext' | 'getFallbackDefault'>,
  input: SessionMemoryInput,
): Promise<{ content: string; diag: DistillDiag; candidates: MemoryCandidate[] }> {
  const { content, diag } = await callDistillLlm(opts, [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: buildPrompt(input) },
  ]);
  return { content, diag, candidates: parseMemoryCandidates(content) };
}

const SYSTEM_PROMPT = `You extract DURABLE project memory from a coding session — facts worth recalling in FUTURE sessions on this codebase.

Priority order (highest value first):
1. USER corrections and stated preferences — the single most valuable memory. Extract them FIRST.
2. decisions (why an approach/library/pattern was chosen)
3. conventions (naming, structure, error handling the project follows)
4. gotchas / non-obvious constraints (ABI mismatches, ordering requirements, footguns)
5. architecture facts (how a subsystem fits together)

Do NOT capture transient state: "currently editing X", "next I will…", task progress, or one-off file lists.
Do NOT capture facts trivially recoverable from the code or git history (file locations, obvious APIs, current versions) — memory is for what a future agent could NOT cheaply rediscover.

ALSO capture durable facts about the USER and how they want the agent to work — these apply across ALL projects, not just this codebase. Only when CLEARLY evidenced (an explicit instruction, a stated preference, or a correction the user gave), never inferred from a single ambiguous action:
- category "user": who the user is — role, expertise, language, environment, constraints
- category "feedback": how they want the agent to work — a preference or a recurring correction (e.g. "always keep files under 200 LOC", "never run git stash on my working tree")

For each memory return:
- title: short, specific (e.g. "Embeddings switch requires re-index")
- content: 1-4 sentences, self-contained
- category: one of architecture | decision | convention | pattern | todo | note | user | feedback
- importance: 0..1 — how reusable/durable (decisions/conventions/user-feedback high; minor notes low)

Return AT MOST 5 memories, ordered by durability — quality over quantity.
Respond ONLY with a JSON array, no prose. Empty array if nothing durable:
[{"title":"…","content":"…","category":"decision","importance":0.8}]`;

function buildPrompt(input: SessionMemoryInput): string {
  const parts: string[] = [];
  if (input.primaryRequest) parts.push(`Task: ${input.primaryRequest}`);
  if (input.decisions?.length) parts.push(`Decisions made:\n${input.decisions.map((d) => `- ${d}`).join('\n')}`);
  if (input.summary) parts.push(`Session summary:\n${input.summary}`);
  if (input.filesTouched?.length) parts.push(`Files touched: ${input.filesTouched.slice(0, 30).join(', ')}`);
  // Style-profile fold (MCP_MEMORY_STYLE_PROFILE) — same call, zero extra LLM
  // cost. The extractor replaces (not appends) the singleton's body.
  if (input.styleProfile !== undefined) {
    parts.push(
      `Current "Project style profile" memory:\n${input.styleProfile ?? '(none yet)'}\n\n` +
      'ADDITIONALLY: if this session revealed project-wide STYLE facts (language/framework, naming, ' +
      'error handling, test layout, formatting conventions), emit ONE extra candidate titled exactly ' +
      '"Project style profile" (category convention, importance 0.9) whose content is the COMPLETE ' +
      'UPDATED profile, ≤600 chars — carry forward still-true parts of the current profile and fold in ' +
      'the new facts. Omit it when the session showed nothing style-related.',
    );
  }
  return `Extract durable project memory from this session.\n\n${parts.join('\n\n')}\n\nRespond with a JSON array (empty if nothing durable).`;
}

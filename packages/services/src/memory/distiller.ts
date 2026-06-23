/**
 * LLM-backed MemoryDistiller — turns a coding-session signal into durable
 * project-memory candidates. Mirrors the doc-search QueryRewriter pattern:
 * resolve a provider/model binding via PipelineProviderResolver
 * (`memory_extraction` / `distiller`), call it, parse defensively.
 *
 * Posture: extract only DURABLE facts (decisions, conventions, gotchas,
 * architecture) — never transient task state. On any failure (no binding,
 * LLM error, unparseable) it returns [] so the session is never affected.
 */
import type { SnapshotCategory } from '@mcp/shared/types.js';
import type { FallbackDefault, PipelineProviderResolver, ResolveContext } from '../pipelines/index.js';
import { pickChatFn, suppressThinkingFor } from '../quality/chat-dispatcher.js';
import type { MemoryCandidate, MemoryDistiller, SessionMemoryInput } from './extractor.js';

const CATEGORIES: ReadonlySet<SnapshotCategory> = new Set<SnapshotCategory>([
  'architecture', 'decision', 'convention', 'pattern', 'todo', 'note', 'gotcha', 'procedure',
  // User-scope categories — the positive distiller may emit these for durable
  // facts about the user; run-end routes them to the global user memory.
  'user', 'feedback',
]);

export interface LlmMemoryDistillerOptions {
  resolver: PipelineProviderResolver;
  resolveContext?: ResolveContext;
  /** Zero-config fallback consulted when no binding row resolves. Lazy —
   *  the operator can change the general default model at runtime. */
  getFallbackDefault?: () => FallbackDefault | null;
  /** Skip the LLM (tests) — returns []. */
  skipLlm?: boolean;
}

export class LlmMemoryDistiller implements MemoryDistiller {
  constructor(private readonly opts: LlmMemoryDistillerOptions) {}

  async distill(input: SessionMemoryInput): Promise<MemoryCandidate[]> {
    if (this.opts.skipLlm) return [];
    const binding = await this.opts.resolver
      .resolveOrNull(
        'memory_extraction', 'distiller', this.opts.resolveContext ?? {},
        this.opts.getFallbackDefault?.() ?? undefined,
      )
      .catch(() => null);
    if (!binding) return [];
    try {
      const chat = pickChatFn(binding);
      // Suppress reasoning: this is one-shot structured extraction, and a
      // thinking model (Gemini 2.5 / GLM) otherwise burns the token budget
      // reasoning and returns empty/truncated JSON → zero candidates.
      const result = await chat(binding, [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildPrompt(input) },
      ], { disableThinking: suppressThinkingFor(binding) });
      return parseMemoryCandidates(result.content);
    } catch {
      return [];
    }
  }
}

const SYSTEM_PROMPT = `You extract DURABLE project memory from a coding session — facts worth recalling in FUTURE sessions on this codebase.

Capture ONLY things that stay true beyond this task:
- decisions (why an approach/library/pattern was chosen)
- conventions (naming, structure, error handling the project follows)
- gotchas / non-obvious constraints (ABI mismatches, ordering requirements, footguns)
- architecture facts (how a subsystem fits together)

Do NOT capture transient state: "currently editing X", "next I will…", task progress, or one-off file lists.

ALSO capture durable facts about the USER and how they want the agent to work — these apply across ALL projects, not just this codebase. Only when CLEARLY evidenced (an explicit instruction, a stated preference, or a correction the user gave), never inferred from a single ambiguous action:
- category "user": who the user is — role, expertise, language, environment, constraints
- category "feedback": how they want the agent to work — a preference or a recurring correction (e.g. "always keep files under 200 LOC", "never run git stash on my working tree")

For each memory return:
- title: short, specific (e.g. "Embeddings switch requires re-index")
- content: 1-4 sentences, self-contained
- category: one of architecture | decision | convention | pattern | todo | note | user | feedback
- importance: 0..1 — how reusable/durable (decisions/conventions/user-feedback high; minor notes low)

Respond ONLY with a JSON array, no prose. Empty array if nothing durable:
[{"title":"…","content":"…","category":"decision","importance":0.8}]`;

function buildPrompt(input: SessionMemoryInput): string {
  const parts: string[] = [];
  if (input.primaryRequest) parts.push(`Task: ${input.primaryRequest}`);
  if (input.decisions?.length) parts.push(`Decisions made:\n${input.decisions.map((d) => `- ${d}`).join('\n')}`);
  if (input.summary) parts.push(`Session summary:\n${input.summary}`);
  if (input.filesTouched?.length) parts.push(`Files touched: ${input.filesTouched.slice(0, 30).join(', ')}`);
  return `Extract durable project memory from this session.\n\n${parts.join('\n\n')}\n\nRespond with a JSON array (empty if nothing durable).`;
}

/**
 * Defensive parse of the LLM response into validated MemoryCandidates.
 * Drops malformed entries, clamps importance, validates category. Pure +
 * exported for unit testing.
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
    if (!item || typeof item !== 'object') continue;
    const o = item as Record<string, unknown>;
    const title = typeof o.title === 'string' ? o.title.trim() : '';
    const content = typeof o.content === 'string' ? o.content.trim() : '';
    if (!title || !content) continue;
    const category: SnapshotCategory = CATEGORIES.has(o.category as SnapshotCategory)
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

/**
 * Procedure distiller — turns a SUCCESSFUL run's command trail into a durable,
 * reusable RECIPE ("how to run the tests here", "how to add a migration") so a
 * future agent doesn't rediscover the working sequence. The 5th memory layer
 * (Voyager-style skill library), specialized to this repo and verified by the
 * run having actually succeeded.
 *
 * Sibling of {@link LlmMemoryDistiller}: same provider binding, same
 * []-on-failure posture, REUSES `parseMemoryCandidates`. Forces category
 * `procedure`. The run-end orchestrator only invokes it when the run SUCCEEDED,
 * so the steps come from commands that actually worked.
 */
import type { FallbackDefault, PipelineProviderResolver, ResolveContext } from '../pipelines/index.js';
import { pickChatFn, suppressThinkingFor } from '../quality/chat-dispatcher.js';
import { parseMemoryCandidates } from './distiller.js';
import type { MemoryCandidate, MemoryDistiller, SessionMemoryInput } from './extractor.js';

export interface ProcedureDistillerOptions {
  resolver: PipelineProviderResolver;
  resolveContext?: ResolveContext;
  /** Zero-config fallback consulted when no binding row resolves (lazy). */
  getFallbackDefault?: () => FallbackDefault | null;
  /** Skip the LLM (tests) — returns []. */
  skipLlm?: boolean;
}

export class ProcedureDistiller implements MemoryDistiller {
  constructor(private readonly opts: ProcedureDistillerOptions) {}

  async distill(input: SessionMemoryInput): Promise<MemoryCandidate[]> {
    if (this.opts.skipLlm) return [];
    const commands = (input.toolTrail ?? []).map((c) => c.trim()).filter(Boolean);
    if (commands.length === 0) return []; // no commands ran → no procedure to capture

    const binding = await this.opts.resolver
      .resolveOrNull(
        'memory_extraction', 'distiller', this.opts.resolveContext ?? {},
        this.opts.getFallbackDefault?.() ?? undefined,
      )
      .catch(() => null);
    if (!binding) return [];
    try {
      const chat = pickChatFn(binding);
      const result = await chat(binding, [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: buildPrompt(input, commands) },
      ], { disableThinking: suppressThinkingFor(binding) });
      // Mint recipes only — force the category so a mislabeling model still lands
      // as a retrievable procedure.
      return parseMemoryCandidates(result.content).map((c) => ({ ...c, category: 'procedure' as const }));
    } catch {
      return [];
    }
  }
}

const SYSTEM_PROMPT = `You extract a reusable PROCEDURE (a "recipe") from a coding session that SUCCEEDED — so a future agent on THIS repo can repeat the task without rediscovering the steps.

Capture a procedure ONLY when the commands show a clear, repeatable how-to that stays true beyond this one task, e.g.:
- how to run the tests / a specific test suite
- how to build, lint, typecheck, or deploy
- how to add a migration / regenerate code / seed data

Do NOT capture one-off exploratory commands (ls, cat, grep, cd) or anything specific to this single task with no reuse value. If there is no durable recipe, return an empty array.

For each recipe return:
- title: the trigger / when-to-use, imperative (e.g. "Run the store package tests")
- content: markdown with these sections —
  ## When  (the trigger / situation)
  ## Steps (the exact commands, in order)
  ## Expected (what success looks like)
- importance: 0..1 — how often it's needed / how non-obvious it is
- referencedFiles: config/script files the recipe depends on (package.json, test config, migrations dir), if any — used for staleness

Respond ONLY with a JSON array, no prose. Empty array if no durable recipe:
[{"title":"…","content":"## When\\n…\\n## Steps\\n\`cmd\`\\n## Expected\\n…","importance":0.7,"referencedFiles":["package.json"]}]`;

function buildPrompt(input: SessionMemoryInput, commands: string[]): string {
  const parts: string[] = [];
  if (input.primaryRequest) parts.push(`Task: ${input.primaryRequest}`);
  parts.push(`Commands that ran successfully (in order):\n${commands.map((c) => `- ${c}`).join('\n')}`);
  if (input.filesTouched?.length) parts.push(`Files touched: ${input.filesTouched.slice(0, 30).join(', ')}`);
  return `Extract a reusable recipe from this successful session.\n\n${parts.join('\n\n')}\n\nRespond with a JSON array (empty if no durable recipe).`;
}

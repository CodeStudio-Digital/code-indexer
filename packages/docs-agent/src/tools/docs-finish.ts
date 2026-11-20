/**
 * docs_finish — terminal tool for the DocsAgent. Capturing this call is
 * how the runner's wrapper knows research is complete.
 *
 * Calling docs_finish:
 *   1. Validates the payload (markdown non-empty, chunk_ids array of numbers, confidence in enum).
 *   2. Writes the payload to a shared mutable slot owned by the wrapper.
 *   3. Aborts the runner via `ctx.runner.abort()` — the loop exits cleanly
 *      and `done` resolves; the wrapper then reads the slot and returns
 *      a DocsResearchResult to the caller.
 *
 * If the agent never calls docs_finish (maxTurns reached, exception),
 * the slot stays empty and the wrapper synthesizes a stub result with
 * `confidence='low'` and an error message.
 */
import type { CoderTool } from "@mcp/code-agent/core/tool.js";
import type { ToolResult } from "@mcp/agent-runtime-host/tool-result.js";
import { ok, err } from "@mcp/agent-runtime-host/tool-result.js";
import type { ResearchConfidence } from '../types.js';
import { DOCS_BUDGET, type DocsEvidenceLedger } from './evidence-ledger.js';
import type { PlanSlot } from './docs-plan.js';
import type { DocStore } from '@mcp/store/doc-store.js';
import { normalizeFootnotes } from '../retrieval/citations.js';

export interface DocsFinishPayload {
  markdown: string;
  chunks_cited: number[];
  confidence: ResearchConfidence;
  notes?: string;
}

export interface DocsFinishSlot {
  payload: DocsFinishPayload | null;
}

export interface DocsFinishToolDeps {
  docStore?: Pick<DocStore, 'getChunksByIds'>;
  scopeIds?: ReadonlySet<number>;
  /** Mutable slot the wrapper inspects after the runner exits. */
  slot: DocsFinishSlot;
  ledger?: DocsEvidenceLedger;
  planSlot?: PlanSlot;
}

const CONFIDENCE_VALUES: ReadonlySet<ResearchConfidence> = new Set(['high', 'medium', 'low']);

export function makeDocsFinishTool(deps: DocsFinishToolDeps): CoderTool {
  return {
    name: 'docs_finish',
    description:
      'Emit your final answer and end the research run. Call this EXACTLY ONCE when you have the markdown ready.\n' +
      'Fields:\n' +
      '  - markdown: the final answer (use docs_synthesize output, or compose manually)\n' +
      '  - chunks_cited: array of chunk_id values you actually cited in the markdown\n' +
      '  - confidence: "high" | "medium" | "low" — how well the docs covered the query\n' +
      '  - notes: optional brief commentary for the caller (e.g. "docs only covered v14; v15 not yet indexed")\n' +
      'After this call returns, the runner stops; further tool calls in the same response will be ignored.',
    source: 'native',
    parameters: {
      type: 'object',
      properties: {
        markdown: {
          type: 'string',
          description: 'Final answer in markdown. Use [^N] footnote markers and a "## Sources" section.',
        },
        chunks_cited: {
          type: 'array',
          items: { type: 'number' },
          description: 'Chunk ids actually cited in the markdown.',
        },
        confidence: {
          type: 'string',
          enum: ['high', 'medium', 'low'],
          description: 'high: every part of the query was answered with cited docs; medium: partial coverage; low: docs don\'t cover this.',
        },
        notes: {
          type: 'string',
          description: 'Optional one-paragraph commentary for the caller. Use to flag gaps, version mismatches, etc.',
        },
      },
      required: ['markdown', 'chunks_cited', 'confidence'],
      additionalProperties: false,
    },
    mutates: false,
    parallelSafe: false,
    riskLevel: 'read',
    interactive: true, // never run in parallel with other tools — terminal
    handler: async (args, ctx): Promise<ToolResult> => {
      let markdown = String(args.markdown ?? '').trim();
      if (!markdown) return err('markdown cannot be empty');
      const rawChunks = Array.isArray(args.chunks_cited) ? args.chunks_cited : [];
      const chunks_cited = [...new Set(rawChunks
        .map((n) => Number(n))
        .filter((n) => Number.isSafeInteger(n) && n > 0))];
      const normalized = normalizeFootnotes(markdown, chunks_cited);
      if (normalized === null) return err('Footnotes must use positions [^1] through [^N] in chunks_cited order. Check the cited IDs.');
      markdown = normalized;
      const rawConfidence = String(args.confidence ?? '').trim().toLowerCase();
      if (!CONFIDENCE_VALUES.has(rawConfidence as ResearchConfidence)) {
        return err(`confidence must be one of: high, medium, low. Got: "${rawConfidence}"`);
      }
      const confidence = rawConfidence as ResearchConfidence;
      const citationLimit = deps.ledger?.maxCitations ?? DOCS_BUDGET.citations;
      if (chunks_cited.length > citationLimit) {
        return err(`chunks_cited exceeds the evidence cap (${citationLimit}).`);
      }
      if (confidence === 'high' && deps.ledger) {
        const problem = deps.ledger.validateHighConfidence(deps.planSlot?.subQuestions?.length ?? 1, chunks_cited);
        if (problem) return err(`high confidence rejected: ${problem}. Use medium confidence or gather the missing evidence.`);
      }
      if (deps.docStore && chunks_cited.length) {
        const evidence = deps.docStore.getChunksByIds(chunks_cited);
        if (evidence.length !== chunks_cited.length || evidence.some(c => deps.scopeIds && !deps.scopeIds.has(c.collection_id))) {
          return err('A cited passage is missing or outside the scope of this task.');
        }
        if (evidence.some(c => deps.ledger?.contentChanged(c.id, c.content_hash))) {
          return err('A cited passage changed after it was read. Read the current revision before finishing.');
        }
      }
      const notes = typeof args.notes === 'string' ? args.notes.trim().slice(0, 1000) : undefined;

      // Already finished? Refuse the duplicate call — keeps the slot stable
      // for the wrapper to consume.
      if (deps.slot.payload != null) {
        return err('docs_finish was already called — additional calls are ignored. The run is being torn down.');
      }

      deps.slot.payload = {
        markdown,
        chunks_cited,
        confidence,
        ...(notes ? { notes } : {}),
      };

      // Best-effort abort — the runner will exit on its next loop iteration.
      // If `runner` isn't on the ctx (e.g. tests that exercise the tool
      // directly), we still wrote the slot, so the caller can detect it.
      try {
        ctx.runner?.abort();
      } catch {
        // Aborting a runner that's already aborted is fine.
      }

      return ok(
        `Research complete. confidence=${confidence}, chunks_cited=${chunks_cited.length}. The wrapper will return the result to the caller.`,
      );
    },
  };
}

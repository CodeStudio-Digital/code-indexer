/**
 * docs_plan — the DocsAgent's FIRST step. Forces the agent to decompose the
 * query into concrete sub-questions before it starts searching, instead of
 * firing one vague query and hoping. Pure bookkeeping: no LLM, no I/O — it
 * just records the decomposition into a shared slot the wrapper reads.
 *
 * Why it matters:
 *   - Multi-part queries ("how do X and Y interact?") get one search per
 *     sub-question instead of a single muddy one (better recall).
 *   - The recorded plan feeds the fidelity review gate's coverage check
 *     (did the final answer address every sub-question?).
 *
 * Mirrors the DocsFinishSlot pattern: a mutable slot owned by the wrapper.
 */
import type { CoderTool } from "@mcp/code-agent/core/tool.js";
import type { ToolResult } from "@mcp/agent-runtime-host/tool-result.js";
import { ok, err } from "@mcp/agent-runtime-host/tool-result.js";

export interface PlanSlot {
  subQuestions: string[] | null;
}

export interface DocsPlanToolDeps {
  slot: PlanSlot;
  onCall?: () => void;
}

/** Soft cap — a doc query that needs >8 sub-questions should be split upstream. */
const MAX_SUB_QUESTIONS = 8;

export function makeDocsPlanTool(deps: DocsPlanToolDeps): CoderTool {
  return {
    name: 'docs_plan',
    description:
      'Record your research plan BEFORE searching. Call this ONCE, first.\n' +
      'Pass `sub_questions`: the distinct things you must answer to fully cover the query, in the order you will tackle them. ' +
      'For a simple query that\'s a single item; for a compound one, break it apart (e.g. ["How is X configured?", "How does X interact with Y?"]).\n' +
      'You will then run one search per sub-question and, at the end, your answer is checked for coverage of each.',
    source: 'native',
    parameters: {
      type: 'object',
      properties: {
        sub_questions: {
          type: 'array',
          items: { type: 'string' },
          description: `Ordered list of sub-questions to answer. 1-${MAX_SUB_QUESTIONS} items.`,
        },
      },
      required: ['sub_questions'],
      additionalProperties: false,
    },
    mutates: false,
    parallelSafe: false,
    riskLevel: 'read',
    handler: async (args): Promise<ToolResult> => {
      deps.onCall?.();
      const raw = Array.isArray(args.sub_questions) ? args.sub_questions : [];
      const subQuestions = raw
        .filter((s): s is string => typeof s === 'string')
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
        .slice(0, MAX_SUB_QUESTIONS);
      if (subQuestions.length === 0) {
        return err('sub_questions must contain at least one non-empty question.');
      }
      deps.slot.subQuestions = subQuestions;
      return ok(
        `Plan recorded (${subQuestions.length} sub-question${subQuestions.length === 1 ? '' : 's'}). ` +
          'Now search for each in turn with docs_search, read full chunks where snippets are truncated, then synthesize.',
      );
    },
  };
}

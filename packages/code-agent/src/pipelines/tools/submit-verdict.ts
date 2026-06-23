/**
 * `submit_verdict` — single-purpose tool given to validator subagents in a
 * chat pipeline. The validator has NO other tools available; its job is
 * to read the upstream stage's output, decide pass/fail/review, and call
 * this once.
 *
 * Capture pattern (no runner-level hook needed):
 *   - `buildSubmitVerdictTool({ ref })` returns a tool that writes the
 *     parsed verdict into the closure-captured `ref` slot.
 *   - The chat executor reads `ref.verdict` after `runSubagent` returns.
 *   - The allowlist passed to the validator subagent is `{ 'submit_verdict' }`,
 *     so this is the only tool the model can call.
 *
 * This is intentionally simpler than registering an event listener on the
 * subagent's runner: only one tool is in play, the runner stays untouched,
 * and the verdict box lives at the executor level where it belongs.
 */
import type { CoderTool, JsonSchema, ToolResult } from '@mcp/code-agent/core/tool.js';
import { ok, err } from '@mcp/code-agent/core/tool.js';

export type Verdict = 'pass' | 'fail' | 'review';
export type VerdictConfidence = 'high' | 'medium' | 'low';

export interface VerdictPayload {
  verdict: Verdict;
  reason: string;
  confidence: VerdictConfidence;
}

export interface VerdictRef {
  /** Most recent verdict accepted by the tool. `null` until the model calls submit_verdict. */
  verdict: VerdictPayload | null;
}

const verdictSchema: JsonSchema = {
  type: 'object',
  properties: {
    verdict: {
      type: 'string',
      enum: ['pass', 'fail', 'review'],
      description:
        '"pass": the upstream output meets the criteria; "fail": it does not; "review": uncertain or needs human review.',
    },
    reason: {
      type: 'string',
      maxLength: 600,
      description:
        'Short justification (≤600 chars) shown in the pipeline timeline. Be specific about what passed or failed.',
    },
    confidence: {
      type: 'string',
      enum: ['high', 'medium', 'low'],
      description: 'How confident you are in the verdict. Default "medium" when omitted.',
    },
  },
  required: ['verdict', 'reason'],
} as unknown as JsonSchema;

/**
 * Construct a `submit_verdict` tool whose handler stores the verdict on
 * the supplied `ref`. The first valid call wins; subsequent calls return
 * an error so the model is nudged to stop emitting tool calls.
 */
export function buildSubmitVerdictTool(deps: { ref: VerdictRef }): CoderTool {
  return {
    name: 'submit_verdict',
    description:
      'Submit the validation verdict for the upstream stage. Call this exactly ONCE, then stop. ' +
      'No further tool calls are needed and no final summary message is required — the orchestrator ' +
      'reads the verdict from this call and routes the pipeline accordingly.',
    parameters: verdictSchema,
    source: 'native',
    mutates: false,
    parallelSafe: false,
    riskLevel: 'read',
    handler: async (args: Record<string, unknown>): Promise<ToolResult> => {
      if (deps.ref.verdict !== null) {
        return err(
          'submit_verdict: a verdict has already been recorded for this stage. Stop calling tools.',
        );
      }
      const verdict = parseVerdict(args.verdict);
      if (!verdict) {
        return err(
          `submit_verdict: invalid verdict "${String(args.verdict)}". Must be one of: pass, fail, review.`,
        );
      }
      const reason = typeof args.reason === 'string' ? args.reason.slice(0, 600) : '';
      if (!reason.trim()) {
        return err('submit_verdict: missing required field `reason`.');
      }
      const confidence = parseConfidence(args.confidence);
      deps.ref.verdict = { verdict, reason, confidence };
      return ok(
        `Verdict recorded: ${verdict} (${confidence}). Pipeline will route along the '${verdict}' branch. Stop now.`,
      );
    },
  };
}

function parseVerdict(v: unknown): Verdict | null {
  if (v === 'pass' || v === 'fail' || v === 'review') return v;
  return null;
}

function parseConfidence(v: unknown): VerdictConfidence {
  if (v === 'high' || v === 'medium' || v === 'low') return v;
  return 'medium';
}

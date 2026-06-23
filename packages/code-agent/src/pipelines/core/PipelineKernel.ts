/**
 * PipelineKernel — pure helpers shared by the company `PipelineExecutor`
 * and the chat `ChatPipelineExecutor`.
 *
 * Everything here is side-effect free and easily unit-testable. The two
 * executors plug their own driver-specific resolvers (QA verdict from
 * `qa_test_runs`, kanban tag, etc.) when the branch mode requires data
 * outside the agent's own output. The kernel never imports company
 * services or store classes — keeping it portable.
 *
 * Re-exported here from the shared `company/types` and `company/services`
 * locations so callers don't need to climb back up:
 *   - `pickNextEdge`            — pure: outgoing edges + verdict → next edge
 *   - `resolveBranchVerdictPure`— pure: branch mode + agent output → verdict
 *   - `renderNodeTask`          — re-export of the existing template
 *                                 renderer in PipelineService.
 */

import { renderNodeTask } from '@mcp/company/services/PipelineService.js';
import type { PipelineEdge, PipelineNode } from '@mcp/company/types.js';

export { renderNodeTask };

export interface PickedEdge {
  outcome: string;
  targetId: string;
}

export type BranchMode = NonNullable<PipelineNode['branchMode']>;

/**
 * Walk the candidate edges from a node and select the one matching the
 * verdict for the node's branch mode. Returns null when nothing matches —
 * callers decide whether that is a clean termination (no outgoing edges
 * at all) or a misconfiguration (verdict produced no branch).
 */
export function pickNextEdge(
  outgoing: PipelineEdge[],
  mode: BranchMode,
  verdict: string | null,
): PickedEdge | null {
  if (mode === 'linear') {
    const linear = outgoing.find((e) => e.kind === 'linear');
    if (!linear) return null;
    return { outcome: 'linear', targetId: linear.to };
  }
  if (mode === 'pass-fail') {
    const want =
      verdict === 'pass' || verdict === 'fail' || verdict === 'review' ? verdict : null;
    if (!want) return null;
    const match = outgoing.find((e) => e.kind === 'pass-fail' && e.on === want);
    if (!match || match.kind !== 'pass-fail') return null;
    return { outcome: want, targetId: match.to };
  }
  if (mode === 'by-tag') {
    if (!verdict) return null;
    const match = outgoing.find((e) => e.kind === 'by-tag' && e.tag === verdict);
    if (!match || match.kind !== 'by-tag') return null;
    return { outcome: verdict, targetId: match.to };
  }
  if (mode === 'by-text-match') {
    if (verdict == null) return null;
    for (const e of outgoing) {
      if (e.kind !== 'by-text-match') continue;
      try {
        if (new RegExp(e.pattern).test(verdict)) {
          return { outcome: e.pattern, targetId: e.to };
        }
      } catch {
        // Bad regex on the edge — skip and let the next match win.
      }
    }
    return null;
  }
  return null;
}

/**
 * Resolve the verdict string a node produced for branch routing. The
 * resolvers come from the executor's environment:
 *   - `qaResolver` — for `pass-fail`, returns 'pass' | 'fail' from a
 *      QA test run if one is linked. Company executor wires this to
 *      `companyStore.getLatestQaVerdictForCard`; chat returns null.
 *   - `tagResolver` — for `by-tag`, returns the kanban tag of the card
 *      this node produced. Chat returns null (no kanban).
 *   - `verdictTokenResolver` — for `pass-fail`, returns 'pass'/'fail'/'review'
 *      from a structured source (e.g. the validator subagent's
 *      `submit_verdict` tool call). When set, takes precedence over the
 *      regex fallback applied to `output`.
 */
export function resolveBranchVerdictPure(args: {
  mode: BranchMode;
  output: string;
  qaResolver?: () => 'pass' | 'fail' | null;
  tagResolver?: () => string | null;
  verdictTokenResolver?: () => 'pass' | 'fail' | 'review' | null;
}): string | null {
  switch (args.mode) {
    case 'linear':
      return null;
    case 'pass-fail': {
      const tokenVerdict = args.verdictTokenResolver?.();
      if (tokenVerdict) return tokenVerdict;
      const qa = args.qaResolver?.();
      if (qa) return qa;
      const m = /\b(PASS|FAIL|REVIEW)\b/i.exec(args.output);
      return m ? m[1].toLowerCase() : null;
    }
    case 'by-tag':
      return args.tagResolver?.() ?? null;
    case 'by-text-match':
      // The pattern lives on each edge — `pickNextEdge` matches against
      // the raw output. Returning the output verbatim keeps the contract.
      return args.output;
  }
}

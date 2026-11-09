import type { AgentWorkResult } from '@mcp/agent-runtime-contracts';
import type { AgentMessage } from '@mcp/provider-sdk';
import type { ToolResult } from '../core/tool.js';

/** Provider-generated call IDs are opaque. Publish the host's exact reference
 * in the result body so a model can cite it without inventing a friendly ID. */
export function withEvidenceReference(result: ToolResult, callId?: string): ToolResult {
  return callId ? { ...result, content: JSON.stringify({ evidenceReference: `tool:${callId}` }) + '\n' + result.content } : result;
}

/** Conservative adapter for legacy text-producing profiles. No prose is promoted
 * to passed verification: evidence must be supplied by the structured producer. */
export function workResult(input: { reason: string; finalText: string; effectOutcome?: 'unknown' }): AgentWorkResult {
  const status = input.reason === 'completed' && input.finalText.trim() ? 'completed'
    : input.reason === 'aborted' ? 'cancelled'
    : ['tool_budget', 'time_budget', 'max_turns', 'max_auto_continues'].includes(input.reason) ? 'partial' : 'failed';
  return { schemaVersion: 1, status, summary: input.finalText, evidence: [], artifacts: [],
    acceptance: status === 'failed' ? 'rejected' : 'unverified', effectOutcome: input.effectOutcome ?? 'confirmed' };
}

export function validateWorkResult(value: unknown): value is AgentWorkResult {
  if (!value || typeof value !== 'object') return false;
  const v = value as AgentWorkResult;
  return v.schemaVersion === 1 && ['completed', 'partial', 'failed', 'needs_input', 'cancelled'].includes(v.status)
    && typeof v.summary === 'string' && ['accepted', 'unverified', 'rejected'].includes(v.acceptance)
    && ['confirmed', 'unknown'].includes(v.effectOutcome) && Array.isArray(v.artifacts) && v.artifacts.every(x => typeof x === 'string')
    && Array.isArray(v.evidence) && v.evidence.every(e => !!e && ['test', 'inspection', 'artifact'].includes(e.kind)
      && typeof e.reference === 'string' && ['passed', 'failed', 'unverified'].includes(e.outcome))
    && (v.acceptance !== 'accepted' || (v.status === 'completed' && v.effectOutcome === 'confirmed'
      && v.evidence.length > 0 && v.evidence.every(e => e.outcome === 'passed')));
}

export const WORK_RESULT_INSTRUCTION = '\nReturn the final summary as <work_result>JSON</work_result> with schemaVersion:1, status:completed|partial|failed|needs_input|cancelled, summary:string, evidence:[{kind:test|inspection|artifact,reference:"tool:<actual tool_use_id>",outcome:passed|failed|unverified}], artifacts:string[], acceptance:accepted|unverified|rejected, effectOutcome:confirmed|unknown, criteria:[{text:<exact acceptance criterion>,status:met|unmet|unverified,evidence:[<evidence reference>]}]. Cite only tool results you actually observed. Mark unverified when no observed check proves a criterion. Do not run unrelated tests merely to populate the result.';

/** One bounded local formatting repair. Invalid semantics cannot be repaired by
 * inventing evidence or by issuing another provider/tool call. */
export function requiredWorkResult(text: string, transcript: AgentMessage[], criteria: string[]): AgentWorkResult {
  let result: AgentWorkResult | null = null;
  try {
    const wrapped = text.match(/<work_result>\s*([\s\S]*?)\s*<\/work_result>/)?.[1] ?? text;
    const raw = wrapped.replace(/^\s*```(?:json)?\s*\n/, '').replace(/\n```\s*$/, '');
    const value = JSON.parse(raw);
    if (validateWorkResult(value)) result = value;
  } catch { /* A malformed result stays rejected after the single local repair. */ }
  if (!result) return { ...workResult({ reason: 'error', finalText: text }), summary: 'invalid_work_result: ' + text, acceptance: 'rejected' };
  const evidence = new Map<string, boolean>();
  for (const message of transcript) for (const block of message.content) {
    if (block.type === 'tool_result') evidence.set(`tool:${block.tool_use_id}`, !block.is_error && block.effect_outcome !== 'unknown');
  }
  const observed = (ref: string) => evidence.get(ref) === true;
  const supported = result.evidence.every(row => row.outcome !== 'passed' || observed(row.reference));
  const accepted = criteria.every(text => Array.isArray(result!.criteria) && result!.criteria.some(row => row?.text === text && row.status === 'met'
    && Array.isArray(row.evidence) && row.evidence.length > 0 && row.evidence.every(observed)));
  if (!supported || !accepted || result.effectOutcome === 'unknown') result = { ...result,
    status: result.status === 'completed' ? 'partial' : result.status, acceptance: 'unverified' };
  return result;
}

import { createHash, randomUUID } from 'node:crypto';
import type { InvocationContextV2, OperationalToolEvent, ResultEvidenceV2 } from '@mcp/agent-runtime-host/invocation-evidence.js';
import type { ToolContext, ToolResult } from './tool.js';

const events: OperationalToolEvent[] = [];
const RETENTION = 7 * 24 * 60 * 60_000;

export function beginInvocation(name: string, ctx: ToolContext): InvocationContextV2 {
  const parent = ctx.invocation;
  const id = randomUUID();
  return { version: 2, invocationId: id, parentInvocationId: parent?.invocationId,
    owner: parent?.owner, projectId: ctx.projectId, toolId: name,
    catalogRevision: parent?.catalogRevision, authorizationRevision: parent?.authorizationRevision,
    deadlineAtEpochMs: ctx.deadlineAtEpochMs ?? parent?.deadlineAtEpochMs,
    cancellationId: parent?.cancellationId ?? id, traceId: parent?.traceId ?? id };
}

export function finishInvocation(result: ToolResult, invocation: InvocationContextV2, start: number, readOnly: boolean, source: OperationalToolEvent['source'], ctx: ToolContext): ToolResult {
  const state: ResultEvidenceV2['state'] = result.error?.kind === 'timeout' ? 'timed_out'
    : result.error?.kind === 'cancelled' ? 'cancelled'
      : result.error?.kind === 'permission' || result.error?.kind === 'refusal' || result.guardVerdict?.action === 'block' ? 'refused'
        : result.isError ? 'failed' : 'succeeded';
  const evidence: ResultEvidenceV2 = { version: 2, invocationId: invocation.invocationId, state,
    // Errors from mutating handlers without a domain receipt cannot prove no effect.
    effect: result.effectOutcome === 'unknown' ? 'unknown' : readOnly || result.error?.code === 'TOOL_DISPATCH_CANCELLED' ? 'none'
      : result.evidence?.effect ?? (state === 'succeeded' ? 'confirmed' : state === 'refused' ? 'none' : 'unknown'),
    completeness: result.sourceTruncations?.length || result.evidence?.completeness === 'partial' ? 'partial' : 'complete',
    dataVersion: result.evidence?.dataVersion,
    truncations: result.sourceTruncations?.map(cut => ({ unit: cut.unit, observed: cut.inputSize,
      observedExact: cut.inputSizeExact !== false, returned: cut.outputSize, reason: cut.technique,
      recovery: cut.outputId && cut.recoverable ? 'artifact' : 'none',
      ...(cut.outputId && cut.recoverable ? { outputRef: cut.outputId } : {}) })),
    timings: { ...result.evidence?.timings, totalMs: Math.max(0, performance.now() - start) } };
  const event: OperationalToolEvent = { version: 2, event: 'tool.finished', invocationId: invocation.invocationId,
    parentInvocationId: invocation.parentInvocationId, toolKey: createHash('sha256').update(invocation.toolId).digest('hex').slice(0, 24),
    source, state, effect: evidence.effect, completeness: evidence.completeness,
    durationMs: evidence.timings.totalMs, outputChars: result.content.length, timestamp: Date.now() };
  events.push(event);
  while (events.length > 1000 || events[0]?.timestamp < Date.now() - RETENTION) events.shift();
  try { ctx.onOperationalToolEvent?.({ ...event }); } catch { /* Observability must not change execution. */ }
  return { ...result, evidence };
}

export function operationalToolEvents(): readonly OperationalToolEvent[] { return events.map(event => ({ ...event })); }

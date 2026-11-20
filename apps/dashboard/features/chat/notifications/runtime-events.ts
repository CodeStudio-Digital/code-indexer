import type { ToolLoopIntervention } from '../../../hooks/agent-stream/types.js';
import { pushNotification, resolveChildAgentApproval } from './session-notifications-store.js';

interface RuntimeEvent {
  id: number;
  ts: number;
  sessionId: string;
  event: string;
  data: unknown;
}

/** Feed the per-session notification center from the app-wide stream. */
export function recordCoderRuntimeNotification(source: RuntimeEvent): void {
  const data = asRecord(source.data);
  const options = { sourceKey: `runtime:${source.ts}:${source.id}`, receivedAt: source.ts };

  if (source.event === 'agents_group_start') {
    return;
  }

  if (source.event === 'agent_progress') {
    // Background agents can emit a terminal progress event before their
    // transcripts are retained. Notify only on agents_group_end, after the
    // group is collectable/resumable, to avoid premature retry guidance and
    // one warning per child.
    return;
  }

  if (source.event === 'agents_group_end') {
    const groupId = readString(data, 'groupId');
    const jobId = readString(data, 'jobId');
    if (!jobId || !groupId) return;
    const agentCount = readNumber(data, 'agentCount') ?? 0;
    const completedCount = readNumber(data, 'completedCount') ?? readNumber(data, 'successCount') ?? 0;
    const partialCount = readNumber(data, 'partialCount') ?? 0;
    const failedCount = readNumber(data, 'failedCount')
      ?? Math.max(0, agentCount - completedCount - partialCount);
    pushNotification(source.sessionId, {
      kind: 'background-agents-done',
      jobId,
      groupId,
      agentCount,
      successCount: completedCount,
      completedCount,
      partialCount,
      failedCount,
      resumableCount: readNumber(data, 'resumableCount') ?? 0,
    }, options);
    return;
  }

  if (source.event === 'child_agent_attention') {
    const childId = readString(data, 'childId');
    if (!childId) return;
    if (readString(data, 'state') === 'resolved') {
      resolveChildAgentApproval(source.sessionId, childId);
      return;
    }
    pushNotification(source.sessionId, {
      kind: 'child-agent-approval',
      childId,
      childTitle: readString(data, 'childTitle') ?? childId,
      projectId: readNumber(data, 'projectId') ?? null,
      resolved: false,
    }, options);
    return;
  }

  if (source.event === 'child_agents_stopped') {
    const count = readNumber(data, 'count') ?? 0;
    if (count > 0) pushNotification(source.sessionId, { kind: 'child-agents-stopped', count, reason: readString(data, 'reason') ?? 'stopped_by_user' }, options);
    return;
  }

  if (source.event === 'tool_loop_intervention') {
    const intervention = source.data as ToolLoopIntervention;
    pushNotification(source.sessionId, { kind: 'tool-loop', intervention }, options);
    return;
  }

  if (source.event === 'done') {
    const error = readString(data, 'error');
    pushNotification(source.sessionId, {
      kind: 'run-done',
      reason: readString(data, 'reason') ?? 'completed',
      ...(error ? { error } : {}),
    }, options);
    return;
  }

  if (source.event === 'error') {
    pushNotification(source.sessionId, {
      kind: 'run-error',
      message: readString(data, 'message') ?? readString(data, 'error') ?? 'unknown',
    }, options);
    return;
  }
}

export function resetRuntimeNotificationStateForTests(): void {
  // Kept for the existing test API; notification processing is now stateless.
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function readString(data: Record<string, unknown>, key: string): string | undefined {
  const value = data[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function readNumber(data: Record<string, unknown>, key: string): number | undefined {
  const value = data[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

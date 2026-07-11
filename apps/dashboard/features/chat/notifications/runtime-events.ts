import type { ToolLoopIntervention } from '../../../hooks/agent-stream/types.js';
import { pushNotification } from './session-notifications-store.js';

interface RuntimeEvent {
  id: number;
  ts: number;
  sessionId: number;
  event: string;
  data: unknown;
}

const backgroundGroups = new Set<string>();

/** Feed the per-session notification center from the app-wide stream. */
export function recordCoderRuntimeNotification(source: RuntimeEvent): void {
  const data = asRecord(source.data);
  const options = { sourceKey: `runtime:${source.ts}:${source.id}`, receivedAt: source.ts };

  if (source.event === 'agents_group_start') {
    if (data.background === true && typeof data.groupId === 'string') {
      backgroundGroups.add(groupKey(source.sessionId, data.groupId));
    }
    return;
  }

  if (source.event === 'agent_progress') {
    const groupId = readString(data, 'groupId');
    const event = readString(data, 'event');
    if (!groupId || !event || !['error', 'timed_out'].includes(event)) return;
    if (!backgroundGroups.has(groupKey(source.sessionId, groupId))) return;
    pushNotification(source.sessionId, {
      kind: 'agent-failed',
      groupId,
      agentIndex: readNumber(data, 'agentIndex') ?? 0,
      label: readString(data, 'label') ?? `Agent ${readNumber(data, 'agentIndex') ?? 0}`,
      reason: event,
    }, options);
    return;
  }

  if (source.event === 'agents_group_end') {
    const groupId = readString(data, 'groupId');
    const jobId = readString(data, 'jobId');
    if (groupId) backgroundGroups.delete(groupKey(source.sessionId, groupId));
    if (!jobId) return;
    pushNotification(source.sessionId, {
      kind: 'background-agents-done',
      jobId,
      agentCount: readNumber(data, 'agentCount') ?? 0,
      successCount: readNumber(data, 'successCount') ?? 0,
    }, options);
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

  if (source.event === 'quality_watchdog_alert') {
    const verdict = readString(data, 'verdict');
    if (verdict !== 'warn' && verdict !== 'flagged' && verdict !== 'error') return;
    pushNotification(source.sessionId, {
      kind: 'quality-alert',
      verdict,
      suspectTool: readString(data, 'suspectTool') ?? '',
      reason: readString(data, 'reason') ?? '',
      turn: readNumber(data, 'turn') ?? 0,
    }, options);
  }
}

export function resetRuntimeNotificationStateForTests(): void {
  backgroundGroups.clear();
}

function groupKey(sessionId: number, groupId: string): string {
  return `${sessionId}:${groupId}`;
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

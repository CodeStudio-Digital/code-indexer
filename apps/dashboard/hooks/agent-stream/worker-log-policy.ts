/**
 * Keep the diagnostic panel useful without mirroring the entire token/progress
 * firehose into its in-memory store. Chat text/thinking already has a canonical
 * rendered/persisted representation, while repeated heartbeats are sampled per
 * operation. Semantic transitions and changed progress notes pass immediately.
 *
 * Two halves of the same projection live here: the policy decides WHAT gets
 * captured, `buildLogEntry` decides how the raw SSE event is SHAPED into a
 * panel row.
 */
import type { WorkerLogEntry } from './types.js';

const DEFAULT_PROGRESS_SAMPLE_MS = 5_000;

type Sample = { at: number; signature: string };

type WorkerLogCapturePolicy = (
  eventName: string,
  data: Record<string, unknown>,
  now?: number,
) => boolean;

export function createWorkerLogCapturePolicy(
  sampleMs = DEFAULT_PROGRESS_SAMPLE_MS,
): WorkerLogCapturePolicy {
  const samples = new Map<string, Sample>();

  return (eventName, data, now = Date.now()) => {
    if (eventName === 'text' || eventName === 'thinking') return false;

    if (eventName === 'agent_progress' && data.event === 'heartbeat') {
      const key = `agent:${String(data.groupId ?? '')}:${String(data.agentIndex ?? '')}`;
      const signature = [data.status, data.phase, data.lastToolName].map(String).join('|');
      return shouldSample(samples, key, signature, now, sampleMs);
    }

    if (eventName === 'operation_progress') {
      const key = `operation:${String(data.opId ?? 'unknown')}`;
      const signature = [data.status, data.phase, data.note].map(String).join('|');
      return shouldSample(samples, key, signature, now, sampleMs);
    }

    if (eventName === 'tool_progress') {
      const key = `tool:${String(data.id ?? data.name ?? 'unknown')}`;
      const signature = [data.name, data.note].map(String).join('|');
      return shouldSample(samples, key, signature, now, sampleMs);
    }

    return true;
  };
}

function shouldSample(
  samples: Map<string, Sample>,
  key: string,
  signature: string,
  now: number,
  sampleMs: number,
): boolean {
  const previous = samples.get(key);
  if (previous && previous.signature === signature && now - previous.at < sampleMs) {
    return false;
  }
  samples.set(key, { at: now, signature });
  return true;
}

/**
 * Derive `{level, category, message}` for the worker-log entry from the
 * raw SSE event name + payload. Most events flow through this fallback;
 * the `worker_log` event itself carries those fields explicitly and is
 * special-cased.
 */
export function buildLogEntry(eventName: string, data: Record<string, unknown>): WorkerLogEntry {
  if (eventName === 'worker_log') {
    const w = data as {
      ts?: number;
      level?: WorkerLogEntry['level'];
      category?: WorkerLogEntry['category'];
      message?: string;
    };
    return {
      ts: typeof w.ts === 'number' ? w.ts : Date.now(),
      event: 'worker_log',
      level: w.level ?? 'info',
      category: w.category ?? 'other',
      message: w.message ?? '(no message)',
      data,
    };
  }
  // Coarse mapping: keep this table tiny — categories are for filtering,
  // not for forensics. The full event name stays in `event` for power users.
  let category: WorkerLogEntry['category'] = 'other';
  let level: WorkerLogEntry['level'] = 'info';
  if (eventName.startsWith('tool_') || eventName.startsWith('task_run_')) category = 'tool';
  else if (eventName.startsWith('operation_') || eventName === 'bt_state_dwell') category = 'runner';
  else if (eventName.startsWith('quality_') || eventName === 'tool_loop_intervention')
    category = 'quality';
  else if (
    eventName === 'provider_call' ||
    eventName === 'provider_swapped' ||
    eventName === 'fallback_activated'
  )
    category = 'provider';
  else if (
    eventName === 'turn_start' ||
    eventName === 'message_complete' ||
    eventName === 'history_compacted' ||
    eventName === 'auto_continue'
  )
    category = 'lifecycle';
  else if (eventName === 'text' || eventName === 'thinking') category = 'message';
  else if (eventName === 'run_started' || eventName === 'done') category = 'runner';
  if (eventName === 'error') level = 'error';
  else if (eventName === 'warning' || eventName === 'tool_loop_intervention') level = 'warn';
  return {
    ts: Date.now(),
    event: eventName,
    level,
    category,
    message: eventName,
    data,
  };
}

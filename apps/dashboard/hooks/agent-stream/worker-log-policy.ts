/**
 * Keep the diagnostic panel useful without mirroring the entire token/progress
 * firehose into its in-memory store. Chat text/thinking already has a canonical
 * rendered/persisted representation, while repeated heartbeats are sampled per
 * operation. Semantic transitions and changed progress notes pass immediately.
 */

const DEFAULT_PROGRESS_SAMPLE_MS = 5_000;

type Sample = { at: number; signature: string };

export type WorkerLogCapturePolicy = (
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

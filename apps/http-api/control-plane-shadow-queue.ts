

export interface CoderControlPlaneShadowMetrics {
  accepted: number;
  existing: number;
  payloadConflicts: number;
  versionConflicts: number;
  runsStarted: number;
  runsTerminalized: number;
  toolBoundaries: number;
  leaseRenewals: number;
  writeErrors: number;
  lifecycleErrors: number;
  divergences: number;
  mirroredByClass: Record<string, number>;
  appendLatency: { p50: number; p95: number; p99: number; samples: number };
  queue: { depth: number; highWatermark: number; dropped: number };
}

export const metrics = {
  accepted: 0,
  existing: 0,
  payloadConflicts: 0,
  versionConflicts: 0,
  runsStarted: 0,
  runsTerminalized: 0,
  toolBoundaries: 0,
  leaseRenewals: 0,
  writeErrors: 0,
  lifecycleErrors: 0,
  divergences: 0,
  queueHighWatermark: 0,
  queueDropped: 0,
};

const mirroredByClass: Record<string, number> = {};

const appendLatencies: number[] = [];

const APPEND_LATENCY_BUFFER = 512;

const DEFAULT_SHADOW_WRITE_QUEUE_CAP = 2_048;

interface ShadowWriteJob {
  label: string;
  write: () => void | Promise<void>;
  resolve: () => void;
}

const shadowWriteQueue: ShadowWriteJob[] = [];

const shadowDrainWaiters: Array<() => void> = [];

let shadowWriteScheduled = false;

let shadowWriteRunning = false;

function shadowWriteQueueCap(): number {
  return DEFAULT_SHADOW_WRITE_QUEUE_CAP;
}

function resolveShadowDrainWaiters(): void {
  if (shadowWriteRunning || shadowWriteQueue.length > 0) return;
  while (shadowDrainWaiters.length > 0) shadowDrainWaiters.shift()?.();
}

async function runNextShadowWrite(): Promise<void> {
  shadowWriteScheduled = false;
  const job = shadowWriteQueue.shift();
  if (!job) {
    shadowWriteRunning = false;
    resolveShadowDrainWaiters();
    return;
  }
  shadowWriteRunning = true;
  await executeShadowWriteJob(job);
  // One filesystem job per event-loop turn. This preserves FIFO while yielding
  // between writes so worker bus publication/IPC stays responsive.
  shadowWriteScheduled = true;
  setImmediate(() => void runNextShadowWrite());
}

async function executeShadowWriteJob(job: ShadowWriteJob): Promise<void> {
  try {
    await measureAppend(job.write, 'queued');
  } catch (error) {
    metrics.lifecycleErrors += 1;
    console.warn(
      `[control-plane-shadow] queued ${job.label} failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    job.resolve();
  }
}

function scheduleShadowWritePump(): void {
  if (shadowWriteScheduled || shadowWriteRunning) return;
  shadowWriteScheduled = true;
  setImmediate(() => void runNextShadowWrite());
}

export function enqueueShadowWrite(
  label: string,
  write: () => void | Promise<void>,
): Promise<void> {
  return new Promise((resolve) => {
    const cap = shadowWriteQueueCap();
    if (shadowWriteQueue.length >= cap) {
      // Only observational journal projections enter this queue. Authority
      // (claim/start/lease/terminal) is committed synchronously, so overload
      // can safely shed this newest observation without unbounded growth.
      metrics.queueDropped += 1;
      resolve();
      return;
    }
    shadowWriteQueue.push({ label, write, resolve });
    metrics.queueHighWatermark = Math.max(metrics.queueHighWatermark, shadowWriteQueue.length);
    scheduleShadowWritePump();
  });
}

/** Wait until every write queued before this call has settled. */
export function drainLocalCoderShadowWrites(): Promise<void> {
  if (!shadowWriteRunning && shadowWriteQueue.length === 0) return Promise.resolve();
  return new Promise((resolve) => shadowDrainWaiters.push(resolve));
}

function recordAppendLatency(ms: number): void {
  appendLatencies.push(ms);
  if (appendLatencies.length > APPEND_LATENCY_BUFFER) {
    appendLatencies.splice(0, appendLatencies.length - APPEND_LATENCY_BUFFER);
  }
}

export async function measureAppend<T>(
  write: () => T | Promise<T>,
  _label?: string,
): Promise<T> {
  const startedAt = performance.now();
  try {
    return await write();
  } finally {
    const ms = performance.now() - startedAt;
    recordAppendLatency(ms);
  }
}

function appendLatencyPercentiles(): { p50: number; p95: number; p99: number; samples: number } {
  const samples = appendLatencies.length;
  if (samples === 0) return { p50: 0, p95: 0, p99: 0, samples: 0 };
  const sorted = [...appendLatencies].sort((a, b) => a - b);
  const pick = (p: number): number =>
    sorted[Math.min(samples - 1, Math.max(0, Math.ceil((p / 100) * samples) - 1))];
  return { p50: pick(50), p95: pick(95), p99: pick(99), samples };
}

export function recordMirrored(eventClass: string, count = 1): void {
  mirroredByClass[eventClass] = (mirroredByClass[eventClass] ?? 0) + count;
}

export function recordLocalCoderShadowDivergences(count: number): void {
  metrics.divergences += count;
}

export function snapshotCoderControlPlaneShadowMetrics(): CoderControlPlaneShadowMetrics {
  const {
    queueHighWatermark,
    queueDropped,
    ...baseMetrics
  } = metrics;
  return {
    ...baseMetrics,
    mirroredByClass: { ...mirroredByClass },
    appendLatency: appendLatencyPercentiles(),
    queue: {
      depth: shadowWriteQueue.length + (shadowWriteRunning ? 1 : 0),
      highWatermark: queueHighWatermark,
      dropped: queueDropped,
    },
  };
}

export function resetCoderControlPlaneShadowMetricsForTests(): void {
  for (const key of Object.keys(metrics) as Array<keyof typeof metrics>) metrics[key] = 0;
  for (const key of Object.keys(mirroredByClass)) delete mirroredByClass[key];
  appendLatencies.length = 0;
}

export interface SubagentMonitorLimits {
  maxToolCalls?: number;
  timeoutMs?: number;
  stallMs?: number;
}

export interface SubagentProgress {
  event: 'heartbeat' | 'tool_call';
  status?: 'running' | 'completed' | 'error' | 'timed_out' | 'aborted';
  toolCallCount: number;
  toolName?: string;
  note?: string;
  phase?: string;
  turn?: number;
  elapsedMs?: number;
  stallMs?: number;
  idleMs?: number;
  deadlineMs?: number;
  lastToolName?: string;
  limit?: SubagentMonitorLimits;
}

interface MonitorArgs {
  limits: SubagentMonitorLimits;
  startedAt: number;
  getToolCallCount: () => number;
  getTurn: () => number;
  getLastToolName: () => string | undefined;
  onProgress?: (progress: SubagentProgress) => void;
  onFail: (message: string, phase: string) => void;
}

export interface SubagentMonitor {
  readonly promise: Promise<never>;
  recordVisual: (phase: string, note: string, extra?: Partial<SubagentProgress>) => void;
  recordSemantic: (phase: string, note: string, extra?: Partial<SubagentProgress>) => void;
  recordProviderCall: (provider: string, model: string) => void;
  recordProviderDelta: (phase: string, note: string, emit?: boolean) => void;
  recordToolProgress: (toolName: string, note: string) => void;
  recordToolResult: (toolName: string) => void;
  fail: (message: string, phase?: string) => void;
  snapshot: () => SubagentMonitorSnapshot;
  cleanup: () => void;
}

export interface SubagentMonitorSnapshot {
  lastAnyEventAt: number;
  lastSemanticProgressAt: number;
  lastProviderDeltaAt?: number;
  lastToolProgressAt?: number;
  semanticIdleMs: number;
  anyIdleMs: number;
}

const SOFT_IDLE_MS = envMs('CODER_SUBAGENT_SOFT_IDLE_MS', 75_000);
const PROVIDER_NO_DELTA_MS = envMs('CODER_SUBAGENT_PROVIDER_NO_DELTA_MS', 120_000);

export function createSubagentMonitor(args: MonitorArgs): SubagentMonitor {
  let settled = false;
  let providerActive = false;
  let providerStartedAt: number | undefined;
  let lastAnyEventAt = args.startedAt;
  let lastSemanticProgressAt = args.startedAt;
  let lastProviderDeltaAt: number | undefined;
  let lastToolProgressAt: number | undefined;
  let lastSoftWarnAt = 0;
  let rejectPromise: (error: Error) => void = () => {};
  const timers: Array<ReturnType<typeof setTimeout> | ReturnType<typeof setInterval>> = [];
  const promise = new Promise<never>((_, reject) => { rejectPromise = reject; });

  const fail = (message: string, phase = 'stalled'): void => {
    if (settled) return;
    settled = true;
    args.onFail(message, phase);
    rejectPromise(new Error(message));
  };

  if (args.limits.timeoutMs != null && args.limits.timeoutMs > 0) {
    timers.push(setTimeout(() => {
      fail(`subagent hard timeout reached (${formatMs(args.limits.timeoutMs!)})`, 'timeout');
    }, args.limits.timeoutMs));
  }

  const intervalMs = Math.min(10_000, Math.max(1_000, Math.floor((args.limits.stallMs ?? 120_000) / 4)));
  timers.push(setInterval(() => {
    const now = Date.now();
    const semanticIdleMs = now - lastSemanticProgressAt;
    if (semanticIdleMs >= SOFT_IDLE_MS && now - lastSoftWarnAt >= SOFT_IDLE_MS) {
      lastSoftWarnAt = now;
      emit('idle_warning', `no semantic subagent progress for ${formatMs(semanticIdleMs)}`);
    }
    const providerBasis = lastProviderDeltaAt ?? providerStartedAt;
    if (providerActive && providerBasis != null && now - providerBasis >= PROVIDER_NO_DELTA_MS) {
      fail(`subagent provider timeout: no provider delta for ${formatMs(now - providerBasis)}`, 'provider_timeout');
      return;
    }
    const stallMs = args.limits.stallMs;
    if (stallMs != null && stallMs > 0 && semanticIdleMs >= stallMs) {
      const tool = args.getLastToolName();
      fail(
        `subagent stalled for ${formatMs(semanticIdleMs)} without semantic progress` +
          `${tool ? ` after ${tool}` : ''}`,
        'stalled',
      );
    }
  }, intervalMs));

  const markAny = (): number => {
    const now = Date.now();
    lastAnyEventAt = now;
    return now;
  };
  const markSemantic = (): number => {
    const now = markAny();
    lastSemanticProgressAt = now;
    return now;
  };
  const emit = (phase: string, note: string, extra: Partial<SubagentProgress> = {}): void => {
    const now = Date.now();
    args.onProgress?.({
      event: 'heartbeat',
      status: 'running',
      toolCallCount: args.getToolCallCount(),
      toolName: args.getLastToolName(),
      note,
      phase,
      turn: args.getTurn(),
      elapsedMs: now - args.startedAt,
      stallMs: now - lastSemanticProgressAt,
      idleMs: now - lastSemanticProgressAt,
      deadlineMs: args.limits.timeoutMs,
      lastToolName: args.getLastToolName(),
      limit: args.limits,
      ...extra,
    });
  };

  return {
    promise,
    recordVisual: (phase, note, extra = {}) => {
      markAny();
      emit(phase, note, extra);
    },
    recordSemantic: (phase, note, extra = {}) => {
      if (phase.startsWith('tool_call')) providerActive = false;
      markSemantic();
      emit(phase, note, extra);
    },
    recordProviderCall: (provider, model) => {
      providerActive = true;
      providerStartedAt = markAny();
      lastProviderDeltaAt = undefined;
      emit('provider_call', `awaiting ${provider}:${model}`);
    },
    recordProviderDelta: (phase, note, shouldEmit = true) => {
      providerActive = true;
      lastProviderDeltaAt = markSemantic();
      if (shouldEmit) emit(phase, note);
    },
    recordToolProgress: (toolName, note) => {
      const isProviderHeartbeat = toolName === 'provider.chat' && /awaiting/i.test(note);
      if (isProviderHeartbeat) {
        markAny();
        emit('tool_progress', note, { toolName });
        return;
      }
      providerActive = false;
      lastToolProgressAt = markSemantic();
      emit('tool_progress', note, { toolName, lastToolName: toolName });
    },
    recordToolResult: (toolName) => {
      providerActive = false;
      lastToolProgressAt = markSemantic();
      emit('tool_call', `${toolName} completed`, {
        event: 'tool_call',
        toolName,
        lastToolName: toolName,
      });
    },
    fail,
    snapshot: () => {
      const now = Date.now();
      return {
        lastAnyEventAt,
        lastSemanticProgressAt,
        ...(lastProviderDeltaAt != null ? { lastProviderDeltaAt } : {}),
        ...(lastToolProgressAt != null ? { lastToolProgressAt } : {}),
        semanticIdleMs: now - lastSemanticProgressAt,
        anyIdleMs: now - lastAnyEventAt,
      };
    },
    cleanup: () => {
      settled = true;
      for (const timer of timers) clearTimeout(timer as ReturnType<typeof setTimeout>);
    },
  };
}

function envMs(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function formatMs(ms: number): string {
  if (ms >= 60_000) return `${Math.round(ms / 60_000)}m`;
  return `${Math.round(ms / 1000)}s`;
}

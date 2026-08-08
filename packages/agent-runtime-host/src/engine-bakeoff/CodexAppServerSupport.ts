import type {
  OssEngineAttemptSpec,
  OssEngineEvent,
  OssEngineEventSink,
} from './types.js';

export const CODESTUDIO_NAMESPACE = 'codestudio';
export const BYPASS_ITEM_TYPES = new Set([
  'commandExecution',
  'fileChange',
  'mcpToolCall',
  'collabToolCall',
  'webSearch',
]);

export interface RunState {
  threadId?: string;
  turnId?: string;
  firstDeltaAt?: Date;
  turnStartedEmitted: boolean;
  toolCallCount: number;
  deniedBuiltInRequestCount: number;
  observedBypassToolCount: number;
  terminal: Deferred<'completed' | 'interrupted' | 'failed'>;
}

export class OssEngineAdapterError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'OssEngineAdapterError';
  }
}

export function createRunState(): RunState {
  return {
    turnStartedEmitted: false,
    toolCallCount: 0,
    deniedBuiltInRequestCount: 0,
    observedBypassToolCount: 0,
    terminal: deferred(),
  };
}

export function buildThreadStartParams(
  spec: OssEngineAttemptSpec,
  aliases: ReadonlyMap<string, OssEngineAttemptSpec['capabilities'][number]>,
): Record<string, unknown> {
  return {
    cwd: spec.cwd,
    approvalPolicy: 'never',
    sandbox: 'read-only',
    serviceName: 'codestudio_oss_bakeoff',
    ...(spec.model ? { model: spec.model } : {}),
    dynamicTools: aliases.size === 0 ? [] : [{
      type: 'namespace',
      name: CODESTUDIO_NAMESPACE,
      description: 'Attempt-scoped tools authorized and executed by CodeStudio ToolHost',
      tools: [...aliases.entries()].map(([name, capability]) => ({
        type: 'function',
        name,
        description: capability.description,
        inputSchema: capability.inputSchema,
        deferLoading: false,
      })),
    }],
  };
}

export function engineEvent(
  spec: OssEngineAttemptSpec,
  now: Date,
  kind: OssEngineEvent['kind'],
  state?: RunState,
  fields: Partial<OssEngineEvent> = {},
): OssEngineEvent {
  return {
    kind,
    attemptId: spec.authority.attemptId,
    occurredAt: now.toISOString(),
    threadId: state?.threadId,
    turnId: state?.turnId,
    ...fields,
  };
}

export async function emit(sink: OssEngineEventSink, value: OssEngineEvent): Promise<void> {
  await sink(value);
}

export function signalForDeadline(deadline: bigint, now: Date): AbortSignal {
  const remaining = deadline - BigInt(now.getTime());
  if (remaining <= 0n) {
    return AbortSignal.abort(new OssEngineAdapterError('attempt_deadline_elapsed', 'Attempt deadline elapsed'));
  }
  return AbortSignal.timeout(Math.min(Number(remaining), 2_147_483_647));
}

export async function waitForTerminal(
  terminal: Deferred<'completed' | 'interrupted' | 'failed'>,
  signal: AbortSignal,
  interrupt: () => Promise<'completed' | 'interrupted' | 'failed'>,
): Promise<'completed' | 'interrupted' | 'failed'> {
  try {
    return await raceWithSignal(terminal.promise, signal);
  } catch (error) {
    if (!signal.aborted) throw error;
    return interrupt();
  }
}

export function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error('Aborted'));
    signal.addEventListener('abort', onAbort, { once: true });
    void promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort);
        resolve(value);
      },
      (error: unknown) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      },
    );
  });
}

export function validateCorrelation(params: Record<string, unknown>, state: RunState): void {
  state.threadId = bindId(state.threadId, textField(params, 'threadId'), 'thread');
  state.turnId = bindId(state.turnId, textField(params, 'turnId'), 'turn');
}

export function validateCorrelationIfPresent(
  params: Record<string, unknown>,
  state: RunState,
): void {
  if (typeof params.threadId === 'string') {
    state.threadId = bindId(state.threadId, params.threadId, 'thread');
  }
  if (typeof params.turnId === 'string') {
    state.turnId = bindId(state.turnId, params.turnId, 'turn');
  }
}

export function validateThread(params: Record<string, unknown>, state: RunState): void {
  if (typeof params.threadId === 'string') {
    state.threadId = bindId(state.threadId, params.threadId, 'thread');
  }
}

export function nestedId(record: Record<string, unknown>, key: string): string {
  return textField(asRecord(record[key], `${key}_missing`), 'id');
}

export function bindId(current: string | undefined, next: string, kind: string): string {
  if (current && current !== next) {
    throw new OssEngineAdapterError(
      `${kind}_correlation_mismatch`,
      `Expected ${kind} ${current}, received ${next}`,
    );
  }
  return next;
}

export function requireBoundId(value: string | undefined, kind: string): string {
  if (!value) throw new OssEngineAdapterError(`${kind}_not_bound`, `${kind} was not bound`);
  return value;
}

export function terminalStatus(value: unknown): 'completed' | 'interrupted' | 'failed' {
  if (value === 'completed' || value === 'interrupted' || value === 'failed') return value;
  throw new OssEngineAdapterError('terminal_status_invalid', `Invalid terminal status ${String(value)}`);
}

export function textField(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string' || value.length === 0) {
    throw new OssEngineAdapterError('field_invalid', `${key} must be a non-empty string`);
  }
  return value;
}

export function optionalText(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

export function asRecord(value: unknown, code: string): Record<string, unknown> {
  if (!isRecord(value)) throw new OssEngineAdapterError(code, code.replaceAll('_', ' '));
  return value;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function elapsedMs(start: Date, end: Date): number {
  return Math.max(0, end.getTime() - start.getTime());
}

export interface Deferred<T> {
  promise: Promise<T>;
  settled: boolean;
  resolve(value: T): void;
  reject(error: Error): void;
}

function deferred<T>(): Deferred<T> {
  let resolvePromise!: (value: T) => void;
  let rejectPromise!: (error: Error) => void;
  const result: Deferred<T> = {
    promise: new Promise<T>((resolve, reject) => {
      resolvePromise = resolve;
      rejectPromise = reject;
    }),
    settled: false,
    resolve: (value) => {
      if (result.settled) return;
      result.settled = true;
      resolvePromise(value);
    },
    reject: (error) => {
      if (result.settled) return;
      result.settled = true;
      rejectPromise(error);
    },
  };
  return result;
}

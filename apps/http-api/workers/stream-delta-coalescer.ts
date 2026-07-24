/**
 * Claude-style stream delta coalescer for the worker -> main MessagePort.
 *
 * Only adjacent deltas with the exact same identity may merge. Any different
 * identity, non-delta event, lifecycle boundary, or terminal event flushes the
 * pending delta first, preserving global event order.
 */

export const DEFAULT_STREAM_DELTA_COALESCE_MS = 16;

export interface WorkerBusEventEnvelope {
  runId?: number;
  seq?: number;
  event: string;
  data: unknown;
}

interface DeltaDescriptor<T> {
  key: string;
  value: string;
  replace: (value: string) => T;
}

export class StreamDeltaCoalescer<T extends WorkerBusEventEnvelope> {
  private pending: T | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly emit: (event: T) => void,
    private readonly windowMs: number = DEFAULT_STREAM_DELTA_COALESCE_MS,
  ) {}

  push(event: T): void {
    if (this.windowMs <= 0) {
      this.flush();
      this.emit(event);
      return;
    }

    if (this.pending) {
      const merged = mergeAdjacentStreamDeltas(this.pending, event);
      if (merged) {
        this.pending = merged;
        return;
      }
      this.flush();
    }

    if (!describeDelta(event)) {
      this.emit(event);
      return;
    }

    this.pending = event;
    this.timer = setTimeout(() => this.flush(), this.windowMs);
    const timer = this.timer as { unref?: () => void };
    timer.unref?.();
  }

  flush(): void {
    if (this.timer != null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (!this.pending) return;
    const event = this.pending;
    this.pending = null;
    this.emit(event);
  }
}

/**
 * Merge helper used by the multi-agent worker's existing 16 ms transport
 * batch. It coalesces only adjacent compatible entries inside that batch,
 * without changing the batch's global ordering.
 */
export function mergeAdjacentStreamDeltas<T extends WorkerBusEventEnvelope>(
  previous: T,
  current: T,
): T | null {
  const left = describeDelta(previous);
  const right = describeDelta(current);
  if (!left || !right || left.key !== right.key) return null;
  return left.replace(left.value + right.value);
}

function describeDelta<T extends WorkerBusEventEnvelope>(
  envelope: T,
): DeltaDescriptor<T> | null {
  if (envelope.event === 'agent_event') {
    const outer = asRecord(envelope.data);
    const innerEvent = stringValue(outer.event);
    if (!innerEvent) return null;
    const inner = describePayloadDelta(innerEvent, outer.data);
    if (!inner) return null;
    const identity = identityKey(envelope, innerEvent, inner.field, outer, inner.record);
    return {
      key: identity,
      value: inner.value,
      replace: (value) => ({
        ...envelope,
        data: {
          ...outer,
          data: inner.replace(value),
        },
      }),
    };
  }

  const delta = describePayloadDelta(envelope.event, envelope.data);
  if (!delta) return null;
  return {
    key: identityKey(envelope, envelope.event, delta.field, {}, delta.record),
    value: delta.value,
    replace: (value) => ({
      ...envelope,
      data: delta.replace(value),
    }),
  };
}

interface PayloadDelta {
  value: string;
  field: string;
  record: Record<string, unknown>;
  replace: (value: string) => unknown;
}

function describePayloadDelta(event: string, data: unknown): PayloadDelta | null {
  const kind = deltaKind(event);
  if (!kind) return null;

  if (typeof data === 'string') {
    return {
      value: data,
      field: '$value',
      record: {},
      replace: (value) => value,
    };
  }

  const record = asRecord(data);
  const candidates = kind === 'input_json'
    ? ['partial_json', 'partialJson']
    : kind === 'thinking'
      ? ['thinking', 'text']
      : ['text'];
  const field = candidates.find((candidate) => typeof record[candidate] === 'string');
  if (!field) return null;
  return {
    value: record[field] as string,
    field,
    record,
    replace: (value) => ({ ...record, [field]: value }),
  };
}

function deltaKind(event: string): 'text' | 'thinking' | 'input_json' | null {
  switch (event) {
    case 'text':
    case 'text_delta':
      return 'text';
    case 'thinking':
    case 'thinking_delta':
      return 'thinking';
    case 'input_json_delta':
    case 'tool_call_args':
      return 'input_json';
    default:
      return null;
  }
}

function identityKey(
  envelope: WorkerBusEventEnvelope,
  event: string,
  field: string,
  outer: Record<string, unknown>,
  inner: Record<string, unknown>,
): string {
  return JSON.stringify([
    envelope.runId ?? null,
    envelope.event,
    event,
    field,
    firstDefined(outer.agent, inner.agent) ?? null,
    firstDefined(outer.agentRunId, inner.agentRunId) ?? null,
    firstDefined(inner.index, outer.index) ?? 0,
    firstDefined(
      inner.parent_tool_use_id,
      inner.parentToolUseId,
      outer.parent_tool_use_id,
      outer.parentToolUseId,
    ) ?? null,
    firstDefined(inner.id, inner.toolUseId, outer.id, outer.toolUseId) ?? null,
  ]);
}

function firstDefined(...values: unknown[]): unknown {
  return values.find((value) => value !== undefined);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  StreamDeltaCoalescer,
  mergeAdjacentStreamDeltas,
  type WorkerBusEventEnvelope,
} from '../stream-delta-coalescer.js';

const FRONTEND_AGENT_RUN_ID = 'a0000000-0000-4000-8000-000000000010';
const BACKEND_AGENT_RUN_ID = 'a0000000-0000-4000-8000-000000000011';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('StreamDeltaCoalescer', () => {
  it('coalesces adjacent text for the same run within 16 ms', () => {
    const emitted: WorkerBusEventEnvelope[] = [];
    const coalescer = new StreamDeltaCoalescer((event) => emitted.push(event), 16);

    coalescer.push({ runId: 7, seq: 1, event: 'text', data: { text: 'hel' } });
    coalescer.push({ runId: 7, seq: 2, event: 'text', data: { text: 'lo' } });
    expect(emitted).toEqual([]);

    vi.advanceTimersByTime(16);
    expect(emitted).toEqual([
      { runId: 7, seq: 1, event: 'text', data: { text: 'hello' } },
    ]);
  });

  it('flushes on field changes and before a terminal boundary', () => {
    const emitted: WorkerBusEventEnvelope[] = [];
    const coalescer = new StreamDeltaCoalescer((event) => emitted.push(event), 16);

    coalescer.push({ runId: 7, seq: 1, event: 'text', data: { text: 'answer' } });
    coalescer.push({ runId: 7, seq: 2, event: 'thinking', data: { text: 'reason' } });
    coalescer.push({ runId: 7, seq: 3, event: 'done', data: { reason: 'completed' } });

    expect(emitted.map((event) => event.event)).toEqual(['text', 'thinking', 'done']);
    expect(emitted[0]?.data).toEqual({ text: 'answer' });
    expect(emitted[1]?.data).toEqual({ text: 'reason' });
  });

  it('coalesces input JSON only for the same tool/index/parent identity', () => {
    const emitted: WorkerBusEventEnvelope[] = [];
    const coalescer = new StreamDeltaCoalescer((event) => emitted.push(event), 16);

    coalescer.push({
      runId: 8,
      seq: 1,
      event: 'tool_call_args',
      data: { id: 'tool-a', index: 0, parentToolUseId: 'parent', partial_json: '{"a":' },
    });
    coalescer.push({
      runId: 8,
      seq: 2,
      event: 'tool_call_args',
      data: { id: 'tool-a', index: 0, parentToolUseId: 'parent', partial_json: '1}' },
    });
    coalescer.push({
      runId: 8,
      seq: 3,
      event: 'tool_call_args',
      data: { id: 'tool-b', index: 0, parentToolUseId: 'parent', partial_json: '{}' },
    });
    coalescer.flush();

    expect(emitted).toHaveLength(2);
    expect(emitted[0]?.data).toMatchObject({
      id: 'tool-a',
      partial_json: '{"a":1}',
    });
    expect(emitted[1]?.data).toMatchObject({
      id: 'tool-b',
      partial_json: '{}',
    });
  });

  it('keeps interleaved company agents separate while merging adjacent deltas', () => {
    const a1: WorkerBusEventEnvelope = {
      seq: 1,
      event: 'agent_event',
      data: {
        agent: 'frontend',
        agentRunId: FRONTEND_AGENT_RUN_ID,
        event: 'text_delta',
        data: 'one',
      },
    };
    const a2: WorkerBusEventEnvelope = {
      seq: 2,
      event: 'agent_event',
      data: {
        agent: 'frontend',
        agentRunId: FRONTEND_AGENT_RUN_ID,
        event: 'text_delta',
        data: ' two',
      },
    };
    const b: WorkerBusEventEnvelope = {
      seq: 3,
      event: 'agent_event',
      data: {
        agent: 'backend',
        agentRunId: BACKEND_AGENT_RUN_ID,
        event: 'text_delta',
        data: 'other',
      },
    };

    const merged = mergeAdjacentStreamDeltas(a1, a2);
    expect(merged).toEqual({
      ...a1,
      data: {
        agent: 'frontend',
        agentRunId: FRONTEND_AGENT_RUN_ID,
        event: 'text_delta',
        data: 'one two',
      },
    });
    expect(mergeAdjacentStreamDeltas(merged!, b)).toBeNull();
    // Inputs stay immutable so replay/audit consumers retain their originals.
    expect(a1.data).toMatchObject({ data: 'one' });
  });

  it('keeps different effective delta fields as an ordering boundary', () => {
    const snake: WorkerBusEventEnvelope = {
      runId: 9,
      seq: 1,
      event: 'tool_call_args',
      data: { id: 'tool-a', index: 0, partial_json: '{"a":' },
    };
    const camel: WorkerBusEventEnvelope = {
      runId: 9,
      seq: 2,
      event: 'tool_call_args',
      data: { id: 'tool-a', index: 0, partialJson: '1}' },
    };

    expect(mergeAdjacentStreamDeltas(snake, camel)).toBeNull();
  });
});

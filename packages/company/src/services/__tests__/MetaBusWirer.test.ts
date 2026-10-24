import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import type { RunCoderHandle } from '@mcp/code-agent/index/types.js';
import type { IMetaBusPublisher } from '../ports.js';
import { MetaBusWirer } from '../MetaBusWirer.js';

const BACKEND_RUN_ID = '00000000-0000-4000-8000-000000000017';
const MASTER_RUN_ID = '00000000-0000-4000-8000-000000000003';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setup() {
  const runner = new EventEmitter();
  const transcript = deferred<Awaited<RunCoderHandle['transcriptFlushed']>>();
  const published: Array<{ event: string; data: unknown }> = [];
  const publisher = {
    publish: vi.fn((event: string, data: unknown) => published.push({ event, data })),
  } as unknown as IMetaBusPublisher;
  const handle = {
    runner,
    transcriptFlushed: transcript.promise,
  } as unknown as RunCoderHandle;

  new MetaBusWirer(publisher).wire(handle, 'backend', BACKEND_RUN_ID);
  return { runner, transcript, published };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('MetaBusWirer', () => {
  it('supports early runner wiring and later durable-terminal attachment without duplicates', async () => {
    const runner = new EventEmitter();
    const transcript = deferred<Awaited<RunCoderHandle['transcriptFlushed']>>();
    const published: Array<{ event: string; data: unknown }> = [];
    const publisher = {
      publish: vi.fn((event: string, data: unknown) => published.push({ event, data })),
    } as unknown as IMetaBusPublisher;
    const wirer = new MetaBusWirer(publisher);

    expect(() => {
      wirer.wire({ runner } as unknown as RunCoderHandle, 'master', MASTER_RUN_ID);
    }).not.toThrow();
    runner.emit('text_delta', 'before handle');

    wirer.wire({
      runner,
      transcriptFlushed: transcript.promise,
    } as unknown as RunCoderHandle, 'master', MASTER_RUN_ID);
    runner.emit('text_delta', 'after handle');
    transcript.resolve({
      reason: 'completed',
      usage: { input_tokens: 1, output_tokens: 1 },
    });
    await flushPromises();

    const envelopes = published.map(({ data }) => data as { event: string });
    expect(envelopes.filter(({ event }) => event === 'text_delta')).toHaveLength(2);
    expect(envelopes.filter(({ event }) => event === 'done')).toHaveLength(1);
  });

  it('normalizes positional stream events and keeps goal success provisional', () => {
    const { runner, published } = setup();

    runner.emit('text_delta', 'hello');
    runner.emit('tool_call_start', 'goal-1', 'create_goal', { objective: 'ship' });
    runner.emit(
      'tool_call_result',
      'goal-1',
      'create_goal',
      { content: 'created', isError: false },
      14,
    );
    runner.emit('goal_mutations_persisted', { toolUseIds: ['goal-1'] });

    expect(published.map(({ data }) => data)).toEqual([
      {
        agent: 'backend',
        agentRunId: BACKEND_RUN_ID,
        event: 'text_delta',
        data: { text: 'hello' },
      },
      {
        agent: 'backend',
        agentRunId: BACKEND_RUN_ID,
        event: 'tool_call_start',
        data: { id: 'goal-1', name: 'create_goal', input: { objective: 'ship' } },
      },
      {
        agent: 'backend',
        agentRunId: BACKEND_RUN_ID,
        event: 'tool_call_result',
        data: {
          id: 'goal-1',
          name: 'create_goal',
          result: { content: 'created', isError: false },
          duration_ms: 14,
          status: 'running',
          persistence: 'pending',
        },
      },
      {
        agent: 'backend',
        agentRunId: BACKEND_RUN_ID,
        event: 'goal_mutations_persisted',
        data: { toolUseIds: ['goal-1'] },
      },
    ]);
  });

  it('publishes terminal completion only after the durable transcript boundary', async () => {
    const { runner, transcript, published } = setup();

    runner.emit('done', 'completed');
    expect(published).toEqual([]);

    transcript.resolve({
      reason: 'completed',
      usage: { input_tokens: 10, output_tokens: 2 },
    });
    await flushPromises();

    expect(published).toEqual([
      {
        event: 'agent_event',
        data: {
          agent: 'backend',
          agentRunId: BACKEND_RUN_ID,
          event: 'done',
          data: { reason: 'completed', error: undefined },
        },
      },
    ]);
  });

  it('publishes an explicit terminal error when transcript persistence rejects', async () => {
    const { transcript, published } = setup();

    transcript.reject(new Error('goal transaction failed'));
    await flushPromises();

    expect(published).toEqual([
      {
        event: 'agent_event',
        data: {
          agent: 'backend',
          agentRunId: BACKEND_RUN_ID,
          event: 'done',
          data: { reason: 'error', error: 'goal transaction failed' },
        },
      },
    ]);
  });
});

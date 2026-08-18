import { describe, expect, it } from 'vitest';
import {
  finalizeLiveVisualizations,
  outcomeForDoneReason,
} from '../live-block-finalize.js';
import type { StreamBlock } from '../types.js';

const activity = (status: string): StreamBlock =>
  ({ type: 'activity', id: 'a1', kind: 'provider', label: 'call', status }) as unknown as StreamBlock;
const taskRun = (status: string): StreamBlock =>
  ({ type: 'task_run', run: { runId: 'r1', status } }) as unknown as StreamBlock;
const workflow = (status: string): StreamBlock =>
  ({ type: 'workflow', run: { workflowId: 'w1', status } }) as unknown as StreamBlock;

const statusOf = (block: StreamBlock): string =>
  block.type === 'activity' ? block.status : (block as { run: { status: string } }).run.status;

describe('finalizeLiveVisualizations', () => {
  it('stamps every still-running visualization with the run outcome', () => {
    const blocks = [activity('running'), taskRun('running'), workflow('running')];

    expect(finalizeLiveVisualizations(blocks, 'completed')).toBe(true);
    expect(blocks.map(statusOf)).toEqual(['completed', 'completed', 'completed']);
  });

  it('never rewrites a visualization that already reported its own end', () => {
    const blocks = [activity('failed'), taskRun('completed'), workflow('partial')];

    expect(finalizeLiveVisualizations(blocks, 'aborted')).toBe(false);
    expect(blocks.map(statusOf)).toEqual(['failed', 'completed', 'partial']);
  });

  it('leaves text, thinking and tool blocks untouched', () => {
    const blocks: StreamBlock[] = [
      { type: 'text', text: 'hi' },
      { type: 'tool', call: { id: 't1', name: 'read_file', status: 'running' } } as StreamBlock,
    ];

    expect(finalizeLiveVisualizations(blocks, 'failed')).toBe(false);
    expect(blocks[1]).toMatchObject({ call: { status: 'running' } });
  });

  it('records a finish timestamp only when one is missing', () => {
    const kept = taskRun('running') as unknown as { run: { status: string; finishedAt?: string } };
    kept.run.finishedAt = '2020-01-01T00:00:00.000Z';
    const stamped = taskRun('running') as unknown as { run: { finishedAt?: string } };

    finalizeLiveVisualizations([kept as unknown as StreamBlock, stamped as unknown as StreamBlock], 'aborted');

    expect(kept.run.finishedAt).toBe('2020-01-01T00:00:00.000Z');
    expect(stamped.run.finishedAt).toBeTruthy();
  });
});

describe('outcomeForDoneReason', () => {
  it('treats a clean finish as completed and anything else as aborted', () => {
    expect(outcomeForDoneReason('completed')).toBe('completed');
    expect(outcomeForDoneReason('aborted')).toBe('aborted');
    expect(outcomeForDoneReason('interrupted')).toBe('aborted');
    expect(outcomeForDoneReason('max_turns')).toBe('aborted');
  });
});

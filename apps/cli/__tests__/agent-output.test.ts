import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { CoderRunner } from '@mcp/code-agent/core/runner.js';
import { wireAgentToolOutput } from '../commands/agent-output.js';

function setup() {
  const runner = new EventEmitter() as unknown as CoderRunner;
  const chunks: string[] = [];
  wireAgentToolOutput(runner, (chunk) => chunks.push(chunk));
  return { runner, chunks };
}

describe('wireAgentToolOutput', () => {
  it('keeps successful goal tools provisional until the durable acknowledgement', () => {
    const { runner, chunks } = setup();

    runner.emit(
      'tool_call_result',
      'goal-1',
      'create_goal',
      { content: 'Goal created.', isError: false },
      12,
    );

    expect(chunks.join('')).toContain('awaiting durable goal commit');
    expect(chunks.join('')).not.toContain('✓');

    runner.emit('goal_mutations_persisted', { toolUseIds: ['goal-1'] });

    expect(chunks.join('')).toContain('✓ create_goal committed');
  });

  it('renders an explicit compensating failure when persistence rejects', () => {
    const { runner, chunks } = setup();

    runner.emit(
      'tool_call_result',
      'goal-2',
      'update_goal',
      { content: 'Goal completed.', isError: false },
      8,
    );
    runner.emit('goal_mutations_persistence_failed', {
      toolUseIds: ['goal-2'],
      message: 'stale goal generation',
    });

    expect(chunks.join('')).toContain(
      '✖ update_goal persistence failed: stale goal generation',
    );
    expect(chunks.join('')).not.toContain('✓');
  });

  it('continues to render non-goal results immediately', () => {
    const { runner, chunks } = setup();

    runner.emit(
      'tool_call_result',
      'read-1',
      'read_file',
      { content: 'file contents', isError: false },
      4,
    );

    expect(chunks.join('')).toContain('✓ (4ms) file contents');
  });
});

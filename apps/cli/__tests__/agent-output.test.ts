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

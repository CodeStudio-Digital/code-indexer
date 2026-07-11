import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LoopBody } from '../loop-rows.js';
import type { ToolLoopIntervention } from '../../../../hooks/agent-stream/types.js';

function render(iv: ToolLoopIntervention): string {
  return renderToStaticMarkup(createElement(LoopBody, { intervention: iv }));
}

describe('LoopBody', () => {
  it('renders failure-streak bodies with the last error', () => {
    const html = render({
      kind: 'failure-streak',
      turn: 5,
      toolName: 'run_command',
      count: 5,
      firstFailureTurn: 1,
      lastError: 'The terminal session is closed.',
      severity: 'refused',
      reason: 'Tool failed repeatedly.',
      receivedAt: 1,
    });
    expect(html).toContain('Tool failure streak');
    expect(html).toContain('run_command');
    expect(html).toContain('failed since turn 1');
    expect(html).toContain('The terminal session is closed.');
  });

  it('renders guard bodies with the snapshot disclosure', () => {
    const html = render({
      kind: 'doom-loop-strict',
      turn: 3,
      toolName: 'read_file',
      count: 3,
      threshold: 3,
      window: 10,
      severity: 'refused',
      reason: 'Repeated the same tool signature.',
      snapshot: {
        strict: ['read_file:{}'],
        fuzzy: ['read_file'],
        dominance: [{ name: 'read_file', hadText: false }],
      },
      receivedAt: 1,
    });
    expect(html).toContain('Doom loop (strict)');
    expect(html).toContain('3/3 in 10-turn window');
    expect(html).toContain('Snapshot');
  });

  it('does not render a snapshot disclosure when the guard event lacks one', () => {
    const html = render({
      kind: 'dominance',
      turn: 10,
      toolName: 'read_file',
      count: 8,
      threshold: 8,
      window: 20,
      severity: 'refused',
      reason: 'Dominant tool usage detected.',
      receivedAt: 1,
    });
    expect(html).toContain('Tool dominance');
    expect(html).not.toContain('Snapshot');
  });
});

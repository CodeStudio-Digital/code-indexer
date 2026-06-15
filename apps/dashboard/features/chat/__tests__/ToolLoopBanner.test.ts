import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { ToolLoopBanner } from '../ToolLoopBanner.js';
import type { ToolLoopIntervention } from '../../../hooks/agent-stream/types.js';

function renderBanner(interventions: ToolLoopIntervention[]): string {
  return renderToStaticMarkup(createElement(ToolLoopBanner, { interventions }));
}

describe('ToolLoopBanner', () => {
  it('renders loop-enforced events without a snapshot', () => {
    const html = renderBanner([
      {
        kind: 'loop-enforced',
        turn: 8,
        toolName: 'update_todo',
        count: 2,
        severity: 'enforced',
        reason: 'Injected a break-the-loop reminder.',
        receivedAt: 1,
      },
    ]);

    expect(html).toContain('Loop enforcement reminder');
    expect(html).toContain('update_todo');
    expect(html).toContain('refused across planning cycles');
  });

  it('renders failure-streak events without a snapshot', () => {
    const html = renderBanner([
      {
        kind: 'failure-streak',
        turn: 5,
        toolName: 'run_command',
        count: 5,
        firstFailureTurn: 1,
        lastError: 'The terminal session is closed.',
        severity: 'refused',
        reason: 'Tool failed repeatedly.',
        receivedAt: 1,
      },
    ]);

    expect(html).toContain('Tool failure streak');
    expect(html).toContain('run_command');
    expect(html).toContain('failed since turn 1');
    expect(html).toContain('The terminal session is closed.');
  });

  it('renders normal guard events with the snapshot disclosure', () => {
    const html = renderBanner([
      {
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
      },
    ]);

    expect(html).toContain('Doom loop (strict)');
    expect(html).toContain('3/3 in 10-turn window');
    expect(html).toContain('Snapshot');
  });

  it('does not throw when a guard-shaped event is missing snapshot', () => {
    const html = renderBanner([
      {
        kind: 'dominance',
        turn: 10,
        toolName: 'read_file',
        count: 8,
        threshold: 8,
        window: 20,
        severity: 'refused',
        reason: 'Dominant tool usage detected.',
        receivedAt: 1,
      },
    ]);

    expect(html).toContain('Tool dominance');
    expect(html).not.toContain('Snapshot');
  });

  it('filters informational duplicate-result markers out of the banner', () => {
    const html = renderBanner([
      {
        kind: 'dup-result-marker',
        severity: 'informational',
        escalationLevel: 'light',
        hitCount: 2,
        toolName: 'read_file',
        originalTurn: 1,
        currentTurn: 2,
        mode: 'light',
        priorIsCompacted: false,
        receivedAt: 1,
      },
    ]);

    expect(html).toBe('');
  });
});

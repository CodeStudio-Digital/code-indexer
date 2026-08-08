import { describe, expect, it } from 'vitest';
import type { CoderTool } from '@mcp/code-agent/core/tool.js';
import {
  checkDupCall,
  createInvocationGuardState,
  normalizeGuardInput,
} from '../tuple-hash-dedup.js';

function call(
  state: ReturnType<typeof createInvocationGuardState>,
  over?: Partial<Parameters<typeof checkDupCall>[0]>,
) {
  return checkDupCall({
    name: 'write_file',
    input: { path: 'a.ts', content: 'x' },
    repeatPolicy: 'mutating',
    turn: 1,
    useId: 'u1',
    invocationState: state,
    ...over,
  });
}

describe('hybrid invocation guard', () => {
  it('never refuses stable calls based on earlier occurrences', () => {
    const state = createInvocationGuardState();
    const verdicts = Array.from({ length: 5 }, (_, i) => call(state, {
      name: 'read_file',
      input: { path: 'a.ts' },
      repeatPolicy: 'stable',
      turn: i + 1,
      useId: `u${i + 1}`,
    }));
    expect(verdicts.every((v) => v.action === 'allow')).toBe(true);
    expect(state.entries.size).toBe(0);
  });

  it.each(['volatile', 'pollable'] as const)('%s calls always execute', (repeatPolicy) => {
    const state = createInvocationGuardState();
    const verdicts = Array.from({ length: 5 }, (_, i) => call(state, {
      name: 'lsp_diagnostics',
      input: { path: 'a.ts' },
      repeatPolicy,
      turn: i + 1,
      useId: `u${i + 1}`,
    }));
    expect(verdicts.every((v) => v.action === 'allow')).toBe(true);
  });

  it('warns on the second and blocks the third identical mutation at one epoch', () => {
    const state = createInvocationGuardState();
    const first = call(state);
    state.noteStateChange(first.key);
    const second = call(state, { turn: 2, useId: 'u2' });
    state.noteStateChange(second.key);
    const third = call(state, { turn: 3, useId: 'u3' });

    expect(first.action).toBe('allow');
    expect(second).toMatchObject({ action: 'warn', count: 2 });
    expect(third).toMatchObject({
      action: 'block',
      reason: 'mutating-repeat-blocked',
      shouldReflect: true,
      affectsFailureStreak: false,
      count: 3,
    });
  });

  it('a different successful state change invalidates the hazardous repeat count', () => {
    const state = createInvocationGuardState();
    const first = call(state);
    state.noteStateChange(first.key);
    expect(call(state, { turn: 2, useId: 'u2' }).action).toBe('warn');

    state.noteStateChange('edit_file|{"path":"different.ts"}');
    expect(call(state, { turn: 3, useId: 'u3' })).toMatchObject({ action: 'allow', count: 1 });
  });

  it('force_reread bypasses all tuple accounting', () => {
    const state = createInvocationGuardState();
    for (let i = 0; i < 5; i++) {
      expect(call(state, {
        name: 'read_file',
        input: { path: 'a.ts', force_reread: true },
        repeatPolicy: 'stable',
        useId: `u${i}`,
      })).toMatchObject({ action: 'allow', reason: 'force-reread' });
    }
    expect(state.entries.size).toBe(0);
  });

});

describe('normalization', () => {
  it('normalizes aliases and schema defaults before keying', () => {
    const tool = {
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          encoding: { type: 'string', default: 'utf8' },
        },
      },
    } as Pick<CoderTool, 'parameters'>;
    expect(normalizeGuardInput(tool, { file_path: 'a.ts' })).toEqual({
      path: 'a.ts',
      encoding: 'utf8',
    });
  });
});

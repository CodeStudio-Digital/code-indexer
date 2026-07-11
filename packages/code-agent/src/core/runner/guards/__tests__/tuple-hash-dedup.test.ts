import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CoderTool } from '@mcp/code-agent/core/tool.js';
import {
  checkDupCall,
  createInvocationGuardState,
  dedupPolicyMode,
  normalizeGuardInput,
  resetDupCalls,
} from '../tuple-hash-dedup.js';
import type { DupCallEntry } from '../../machine/types.js';

let previousPolicy: string | undefined;

beforeEach(() => {
  previousPolicy = process.env.CODER_DEDUP_POLICY;
  delete process.env.CODER_DEDUP_POLICY;
});

afterEach(() => {
  if (previousPolicy === undefined) delete process.env.CODER_DEDUP_POLICY;
  else process.env.CODER_DEDUP_POLICY = previousPolicy;
});

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
  it('defaults safely to hybrid for missing/invalid values', () => {
    expect(dedupPolicyMode()).toBe('hybrid');
    process.env.CODER_DEDUP_POLICY = 'invalid';
    expect(dedupPolicyMode()).toBe('hybrid');
  });

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

  it('observe mode records would-block without stopping the third mutation', () => {
    process.env.CODER_DEDUP_POLICY = 'observe';
    const state = createInvocationGuardState();
    const first = call(state);
    state.noteStateChange(first.key);
    const second = call(state, { useId: 'u2' });
    state.noteStateChange(second.key);
    expect(call(state, { useId: 'u3' })).toMatchObject({
      action: 'shadow',
      wouldBlock: true,
      shouldReflect: false,
      count: 3,
    });
  });
});

describe('normalization and rollback', () => {
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

  it('legacy mode preserves the old warning/refusal sequence', () => {
    process.env.CODER_DEDUP_POLICY = 'legacy';
    const dupCalls = new Map<string, DupCallEntry>();
    const base = {
      name: 'read_file',
      input: { path: 'a.ts' },
      repeatPolicy: 'stable' as const,
      dupCalls,
    };
    expect(checkDupCall({ ...base, turn: 1, useId: 'u1' }).action).toBe('allow');
    expect(checkDupCall({ ...base, turn: 2, useId: 'u2' }).action).toBe('warn');
    expect(checkDupCall({ ...base, turn: 3, useId: 'u3' }).action).toBe('block');
    expect(dupCalls.size).toBe(1);
    resetDupCalls(dupCalls);
    expect(dupCalls.size).toBe(0);
  });
});

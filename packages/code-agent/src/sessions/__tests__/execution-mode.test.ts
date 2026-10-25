import { describe, expect, it } from 'vitest';
import { detectTurnUltraKeyword, resolveSessionExecutionPolicy } from '../execution-mode.js';
import { resolveUltraPreset } from '../ultra-policy.js';

describe('session execution policy', () => {
  it('keeps ordinary concurrency and applies Ultra host caps without raising reasoning or permissions', () => {
    expect(resolveUltraPreset({ enabled: false }).effective.parallelism.maxAgents).toBe(4);
    const policy = resolveUltraPreset({ enabled: true, effort: 'low', maxParallel: 2, readOnly: true });
    expect(policy.effective).toMatchObject({ reasoning: { effort: 'low' }, isolation: 'shared_read', parallelism: { maxAgents: 2 } });
    expect(resolveUltraPreset({ enabled: true, canDelegate: false }).effective).toMatchObject({ orchestration: 'off', parallelism: { maxAgents: 0 } });
  });
  it('keeps legacy Ultra active despite the post-migration standard default', () => {
    expect(resolveSessionExecutionPolicy('standard', ' Ultra ')).toEqual({
      ultraEnabled: true,
      reasoningEffort: undefined,
    });
  });

  it('preserves explicit reasoning when Ultra orchestration is enabled', () => {
    expect(resolveSessionExecutionPolicy('ultra', 'high')).toEqual({
      ultraEnabled: true,
      reasoningEffort: 'high',
    });
  });

  it('preserves a native effort in standard mode', () => {
    expect(resolveSessionExecutionPolicy('standard', ' high ')).toEqual({
      ultraEnabled: false,
      reasoningEffort: 'high',
    });
  });
});

describe('detectTurnUltraKeyword', () => {
  it('requires an explicit command and ignores mentions and quotes', () => {
    expect(detectTurnUltraKeyword('refatora isso, ultracode', false)).toBe(false);
    expect(detectTurnUltraKeyword('/ULTRACODE varre o repo', false)).toBe(true);
  });

  it('does NOT fire on bare "ultra" or words containing it', () => {
    expect(detectTurnUltraKeyword('liga o modo ultra', false)).toBe(false);
    expect(detectTurnUltraKeyword('ultracodex não conta', false)).toBe(false);
    expect(detectTurnUltraKeyword(undefined, false)).toBe(false);
  });

  it('is a no-op when the session is already Ultra', () => {
    expect(detectTurnUltraKeyword('ultracode', true)).toBe(false);
  });
});

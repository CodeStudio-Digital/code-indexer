import { describe, expect, it } from 'vitest';
import { resolveSessionExecutionPolicy } from '../execution-mode.js';

describe('session execution policy', () => {
  it('keeps legacy Ultra active despite the post-migration standard default', () => {
    expect(resolveSessionExecutionPolicy('standard', ' Ultra ')).toEqual({
      ultraEnabled: true,
      reasoningEffort: 'ultra',
    });
  });

  it('uses the virtual marker when the dedicated mode is Ultra', () => {
    expect(resolveSessionExecutionPolicy('ultra', 'high')).toEqual({
      ultraEnabled: true,
      reasoningEffort: 'ultra',
    });
  });

  it('preserves a native effort in standard mode', () => {
    expect(resolveSessionExecutionPolicy('standard', ' high ')).toEqual({
      ultraEnabled: false,
      reasoningEffort: 'high',
    });
  });
});

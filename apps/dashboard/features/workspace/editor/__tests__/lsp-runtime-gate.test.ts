import { describe, expect, it } from 'vitest';
import { lspRuntimeGate } from '../lsp-runtime-gate.js';

describe('lspRuntimeGate', () => {
  it('prioritizes the profile-specific Node requirement', () => {
    expect(lspRuntimeGate({
      state: 'failed',
      nodeRuntime: {
        range: '>=10.9.0 <13.0.0',
        satisfied: false,
        reason: 'incompatible Node',
      },
    })).toEqual({
      kind: 'node',
      label: 'Node >=10.9.0 <13.0.0',
      reason: 'incompatible Node',
    });
  });

  it('retains Java and .NET runtime prompts', () => {
    expect(lspRuntimeGate({
      state: 'failed',
      runtime: { kind: 'java', minMajor: 17, satisfied: false },
    })).toEqual({ kind: 'java', label: 'JDK 17+', reason: undefined });
  });
});

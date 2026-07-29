import { describe, expect, it } from 'vitest';
import { asSessionId } from '@mcp/session-storage';
import {
  resolveAndPersistRunCoderExecutionPolicy,
  type RunCoderExecutionResolution,
} from '../../index.js';

async function resolveWithCallLog(input: {
  mode?: 'standard' | 'ultra' | null;
  storedEffort?: string | null;
  executionMode?: 'standard' | 'ultra';
  reasoningEffort?: string;
}): Promise<{ result: RunCoderExecutionResolution; calls: string[] }> {
  const calls: string[] = [];
  const result = await resolveAndPersistRunCoderExecutionPolicy(
    {
      setSessionExecutionMode: async (_id, mode) => {
        calls.push(`mode:${mode}`);
      },
      setSessionReasoningEffort: async (_id, effort) => {
        calls.push(`effort:${effort ?? 'null'}`);
      },
    },
    {
      id: asSessionId('00000000-0000-4000-8000-000000000007'),
      execution_mode_override: input.mode ?? 'standard',
      reasoning_effort_override: input.storedEffort ?? null,
    },
    {
      executionMode: input.executionMode,
      reasoningEffort: input.reasoningEffort,
    },
  );
  return { result, calls };
}

describe('direct runCoder execution contract', () => {
  it('persists an explicit mode and keeps a native Standard effort', async () => {
    const { result, calls } = await resolveWithCallLog({
      executionMode: 'standard',
      reasoningEffort: ' high ',
    });

    expect(calls).toEqual(['mode:standard']);
    expect(result).toEqual({
      sessionExecutionMode: 'standard',
      storedReasoningEffort: null,
      policy: { ultraEnabled: false, reasoningEffort: 'high' },
    });
  });

  it('lets an explicit Standard mode override the legacy Ultra spelling', async () => {
    const { result, calls } = await resolveWithCallLog({
      executionMode: 'standard',
      reasoningEffort: ' Ultra ',
    });

    expect(calls).toEqual(['mode:standard']);
    expect(result.policy).toEqual({
      ultraEnabled: false,
      reasoningEffort: undefined,
    });
  });

  it('upgrades a legacy Ultra request without persisting an effort sentinel', async () => {
    const { result, calls } = await resolveWithCallLog({ reasoningEffort: 'ultra' });

    expect(calls).toEqual(['mode:ultra']);
    expect(result.policy).toEqual({
      ultraEnabled: true,
      reasoningEffort: 'ultra',
    });
    expect(result.storedReasoningEffort).toBeNull();
  });

  it('repairs a stored legacy sentinel after persisting its Ultra mode', async () => {
    const { result, calls } = await resolveWithCallLog({ storedEffort: ' ULTRA ' });

    expect(calls).toEqual(['mode:ultra', 'effort:null']);
    expect(result.sessionExecutionMode).toBe('ultra');
    expect(result.storedReasoningEffort).toBeNull();
  });
});

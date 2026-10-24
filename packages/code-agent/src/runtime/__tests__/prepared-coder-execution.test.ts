import { describe, expect, it, vi } from 'vitest';
import { ToolRegistry } from '../../core/registry.js';
import { startPreparedCoderExecution } from '../prepared-coder-execution.js';

type Input = Parameters<typeof startPreparedCoderExecution>[0];
function fixture(effectiveAgentId: string | null, overrides: Partial<Input['opts']> = {}): Input {
  const registry = new ToolRegistry(); registry.seal();
  const done = Promise.resolve({ reason: 'completed', usage: { input_tokens: 0, output_tokens: 0 } });
  return {
    opts: { userMessage: 'Implement feature', controlPlaneParentAgentRunId: '00000000-0000-4000-8000-000000000002',
      ...overrides } as Input['opts'],
    session: { id: '00000000-0000-4000-8000-000000000001', provider: 'openai', model: 'fixture' } as Input['session'],
    indexStatus: {} as Input['indexStatus'], registry, catalogOnlyCapabilities: [],
    toolContext: { cwd: 'D:/fixture', projectName: 'fixture' }, provider: {} as Input['provider'],
    systemPrompt: 'Fixture', initialMessages: [], agentDefinitionId: 'custom-selection', effectiveAgentId,
    capabilityProfile: 'full', permissionMode: 'ask', thinking: false, cleanup: vi.fn(async () => {}),
    executor: vi.fn(async () => ({ done, transcriptFlushed: done, cancel: async () => {},
      provideInput: async () => false, resolveInteraction: async () => {} })),
  };
}

describe('native preparation policy handoff', () => {
  it.each([
    ['spec', undefined, true], ['spec', false, false], ['build', true, true],
    ['build', undefined, false], [null, undefined, false],
  ] as const)('resolves spec mode for effective agent %s and override %s', async (agent, override, expected) => {
    const input = fixture(agent, { specMode: override });
    const handle = await startPreparedCoderExecution(input); await handle.done;
    const prepared = vi.mocked(input.executor).mock.calls[0]![0];
    expect(prepared.preparation.policy.specMode).toBe(expected);
    // A custom selection identity does not replace the resolved execution agent.
    expect(prepared.preparation.agentDefinitionId).toBe('custom-selection');
    expect(input.cleanup).toHaveBeenCalledOnce();
  });

  it.each([true, false])('keeps the resolved plan mode %s at the handoff', async planMode => {
    const input = fixture('build', { planMode });
    await (await startPreparedCoderExecution(input)).done;
    expect(vi.mocked(input.executor).mock.calls[0]![0].preparation.policy.planMode).toBe(planMode);
  });

  it('does not invoke the native owner after cancellation and still releases preparation resources', async () => {
    const controller = new AbortController(); controller.abort(new Error('Stopped before handoff'));
    const input = fixture('spec', { signal: controller.signal });
    await expect(startPreparedCoderExecution(input)).rejects.toThrow('Stopped before handoff');
    expect(input.executor).not.toHaveBeenCalled(); expect(input.cleanup).toHaveBeenCalledOnce();
  });
});

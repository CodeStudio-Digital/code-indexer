import { describe, expect, it, vi } from 'vitest';
import { asAgentRunId, asSessionId, type CoderAttemptAdmissionV1 } from '@mcp/agent-runtime-contracts';
import { ToolRegistry } from '../../core/registry.js';
import { admitCoderAttempt, preparationSha256, prepareCoderAttempt } from '../attempt-preparation.js';

export function preparationFixture() {
  const registry = new ToolRegistry();
  const parameters = { type: 'object' as const, properties: { path: { type: 'string' as const } } };
  registry.register({ name: 'read_file', description: 'Read a file', parameters, source: 'native',
    handler: async () => ({ content: 'ok' }) });
  registry.seal();
  const preparation = prepareCoderAttempt({
    sessionId: asSessionId('00000000-0000-4000-8000-000000000001'),
    agentRunId: asAgentRunId('00000000-0000-4000-8000-000000000002'),
    runnerRunId: 'runner-1',
    provider: 'openai', model: 'selected-model', agentDefinitionId: 'build',
    systemPromptSha256: 'a'.repeat(64), capabilityProfile: 'full',
    environment: { kind: 'host', cwd: 'D:/project' },
    policy: { permissionMode: 'ask', planMode: false, specMode: false },
  }, registry);
  const receipt: CoderAttemptAdmissionV1 = {
    schemaVersion: 1, sessionId: preparation.sessionId, agentRunId: preparation.agentRunId,
    attemptId: '00000000-0000-4000-8000-000000000003', executorOwnerId: 'worker',
    fencingEpoch: 1, preparationSha256: preparationSha256(preparation),
    preparationRef: 'checkpoints/control-plane/prepared.json', runtimeGeneration: 'legacy_ts',
  };
  return { preparation, receipt, parameters };
}

describe('worker attempt admission barrier', () => {
  it('waits for the durable receipt before allowing provider execution', async () => {
    const { preparation, receipt } = preparationFixture();
    let commit!: (value: CoderAttemptAdmissionV1) => void;
    const durable = new Promise<CoderAttemptAdmissionV1>((resolve) => { commit = resolve; });
    const provider = vi.fn();
    const run = admitCoderAttempt(preparation, () => durable).then(provider);
    await Promise.resolve();
    expect(provider).not.toHaveBeenCalled();
    commit(receipt);
    await run;
    expect(provider).toHaveBeenCalledOnce();
  });

  it('does not enter the provider after disk failure, receipt drift or cancellation during admission', async () => {
    const { preparation, receipt } = preparationFixture();
    const provider = vi.fn();
    await expect(admitCoderAttempt(preparation, async () => { throw new Error('disk full'); })
      .then(provider)).rejects.toThrow('disk full');
    await expect(admitCoderAttempt(preparation, async () => ({ ...receipt, preparationSha256: 'b'.repeat(64) }))
      .then(provider)).rejects.toThrow('receipt');
    const abort = new AbortController();
    await expect(admitCoderAttempt(preparation, async () => { abort.abort(); return receipt; }, abort.signal)
      .then(provider)).rejects.toThrow();
    expect(provider).not.toHaveBeenCalled();
  });

  it('detaches schemas from mutable registrations and rejects an unsealed catalog', () => {
    const { preparation, parameters, receipt } = preparationFixture();
    parameters.properties.path.type = 'number' as 'string';
    expect(preparationSha256(preparation)).toBe(receipt.preparationSha256);
    expect(() => prepareCoderAttempt(preparation, new ToolRegistry())).toThrow('sealed');
  });

  it('cancels without waiting for a stuck host and observes its late rejection', async () => {
    const { preparation } = preparationFixture();
    const abort = new AbortController();
    let fail!: (error: unknown) => void;
    const pending = new Promise<CoderAttemptAdmissionV1>((_resolve, reject) => { fail = reject; });
    const admitted = admitCoderAttempt(preparation, () => pending, abort.signal);
    abort.abort(new Error('user stop'));
    await expect(admitted).rejects.toThrow('user stop');
    fail(new Error('late disk failure'));
    await Promise.resolve();
  });
});

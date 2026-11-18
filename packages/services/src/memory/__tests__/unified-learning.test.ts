import { expect, it, vi } from 'vitest';
import { createRunEndMemory } from '../run-end.js';
import { callConfiguredChat } from '../../quality/binding-chat.js';
import { PIPELINE_CATALOG } from '../../pipelines/catalog.js';
vi.mock('../../quality/binding-chat.js', () => ({ bindingProblem: () => null, callConfiguredChat: vi.fn(async () => ({
  content: JSON.stringify([{ title: 'fixture procedure', content: 'Verified build recipe', category: 'procedure', importance: 0.7 }]), latencyMs: 1,
})) }));

it('uses one learning call for facts, fixes and verified procedures; exposes only one memory LLM pipeline', async () => {
  const binding = { provider: { id: 'fixture', kind: 'openai', api_key: 'fixture' }, modelId: 'fixture', config: {}, resolvedFrom: 'global' };
  const resolver = { resolveChain: async () => [binding] } as any;
  const create = vi.fn(async () => undefined);
  const memory = createRunEndMemory({ resolver, writer: { create, update: async () => undefined },
    search: { searchSnapshotsHybrid: async () => [] } });
  expect(await memory.extractAndPersist(7, 'fixture', { summary: 'Verified fix', errorsAndFixes: ['Missing dependency was added'], toolTrail: ['fixture test --isolated'], succeeded: true })).toMatchObject({ hadError: false, created: 1 });
  expect(callConfiguredChat).toHaveBeenCalledOnce();
  const messages = vi.mocked(callConfiguredChat).mock.calls[0]![1];
  expect(messages[1]!.content).toContain('Missing dependency was added');
  expect(messages[1]!.content).toContain('fixture test --isolated');
  expect(messages[0]!.content).toContain('Repetition of recalled');
  expect(PIPELINE_CATALOG.filter(entry => entry.pipelineName.startsWith('memory_')).map(entry => entry.pipelineName)).toEqual(['memory_extraction']);
});

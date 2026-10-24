import { expect, it, vi } from 'vitest';
import { AgentMemoryWriter } from '../agent-memory-writer.js';
const data = { title: 'Convention', category: 'convention' as const, content: 'Bound reads', source: 'agent', importance: 0.6 };
function fixture(durable = true) {
  const service = { hasDurableMutationQueue: durable, create: vi.fn(() => ({ id: 1 })), replace: vi.fn(() => ({ id: 2 })),
    embedAndUpsert: vi.fn(async () => {}), removeVectors: vi.fn(async () => {}), runMutationBatch: vi.fn(fn => fn()) };
  const db = { getAgentMemoryById: () => ({ id: 1, scope: 'project', project_id: 7, content: 'old' }), setAgentMemoryImportance: vi.fn() };
  return { service, db };
}
it('defers embeddings only behind a durable queue and still persists replacement through the service', async () => {
  const f = fixture(); const assertCurrent = vi.fn();
  const writer = new AgentMemoryWriter(f.db as any, f.service as any, undefined, { deferEmbeddings: true, assertCurrent });
  await writer.runBatch(async () => { await writer.create(7, data); await writer.update(1, { content: 'new' }); });
  expect(f.service.create).toHaveBeenCalledOnce(); expect(f.service.replace).toHaveBeenCalledOnce();
  expect(f.service.runMutationBatch).toHaveBeenCalledOnce(); expect(assertCurrent).toHaveBeenCalledTimes(3);
  expect(f.service.embedAndUpsert).not.toHaveBeenCalled(); expect(f.service.removeVectors).not.toHaveBeenCalled();
  const noQueue = fixture(false);
  expect(() => new AgentMemoryWriter(noQueue.db as any, noQueue.service as any, undefined, { deferEmbeddings: true, assertCurrent })).toThrow('durable mutation queue');
});
it.each(['cancel', 'revoke'])('rechecks %s inside the relational queue, immediately before persistence', async mode => {
  const f = fixture(); const controller = new AbortController(); let valid = true; let execute!: () => void;
  const queue = { run: <T>(fn: () => T): Promise<T> => new Promise((resolve, reject) => { execute = () => { try { resolve(fn()); } catch (e) { reject(e); } }; }) };
  const writer = new AgentMemoryWriter(f.db as any, f.service as any, queue, {
    signal: controller.signal, assertCurrent() { if (!valid) throw new Error('revoked'); }, deferEmbeddings: true });
  const pending = writer.create(7, data); const rejected = expect(pending).rejects.toThrow(/cancelled|revoked/);
  if (mode === 'cancel') controller.abort(new Error('cancelled')); else valid = false;
  execute(); await rejected; expect(f.service.create).not.toHaveBeenCalled();
});
it('preserves embedding on the legacy write path', async () => {
  const f = fixture(); await new AgentMemoryWriter(f.db as any, f.service as any).create(7, data);
  expect(f.service.embedAndUpsert).toHaveBeenCalledWith({ id: 1 });
});
it('preserves referenced files on body replacement and accepts new dependencies without changing the body', async () => {
  const f = fixture(); f.db.getAgentMemoryById = () => ({ id: 1, scope: 'project', project_id: 7, content: 'old',
    referenced_files: JSON.stringify([{ path: 'old.ts', hash: 'hash-1' }]) });
  const writer = new AgentMemoryWriter(f.db as any, f.service as any);
  await writer.update(1, { content: 'new', referencedFiles: ['new.ts'] });
  expect(f.service.replace).toHaveBeenLastCalledWith(1, expect.objectContaining({ content: 'new', referencedFiles: ['old.ts', 'new.ts'] }));
  await writer.update(1, { referencedFiles: ['new.ts'] });
  expect(f.service.replace).toHaveBeenLastCalledWith(1, expect.objectContaining({ content: 'old', referencedFiles: ['old.ts', 'new.ts'] }));
  await writer.update(1, { content: 'new' });
  expect(f.service.replace).toHaveBeenLastCalledWith(1, expect.objectContaining({ referencedFiles: ['old.ts'] }));
});

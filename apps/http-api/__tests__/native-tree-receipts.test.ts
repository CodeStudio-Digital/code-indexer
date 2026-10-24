import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { expect, it } from 'vitest';
import { supervisorFactFixture } from './supervisor-fact-fixture.js';

it('durably retains native tree payloads with exact idempotency and bounded storage', async () => {
  const f = await supervisorFactFixture('coder');
  try {
    const payload = { schema: 1, type: 'inbox', sourceAgentRunId: 'source', envelope: {
      id: 'message', from: '/root', to: '/root/agent-child', kind: 'message', message: 'Read only seed.txt.' } };
    expect(await f.store.commitRuntimeRequest(f.context, 'native-tree:inbox:message', payload)).toBe(true);
    expect(await f.store.commitRuntimeRequest(f.context, 'native-tree:inbox:message', payload)).toBe(false);
    await expect(f.store.commitRuntimeRequest(f.context, 'native-tree:inbox:message', { ...payload, sourceAgentRunId: 'other' })).rejects.toThrow('different input');
    const records = (await f.repository.list('runtimeRequest')).items;
    expect(records).toHaveLength(1); expect(records[0]!.data.nativeTree).toEqual(payload);
    await expect(f.store.commitRuntimeRequest(f.context, 'native-tree:job:large', { schema: 1, type: 'job', task: 'x'.repeat(300_000) })).rejects.toThrow('oversized');
    await expect(f.store.commitRuntimeRequest(f.context, 'native-tree:bad', { schema: 1, type: 'grant', approved: true })).rejects.toThrow('Invalid');
    expect((await f.repository.list('runtimeRequest')).items).toHaveLength(1);
  } finally {
    await f.sessions.close();
    if (!resolve(f.directory).toLowerCase().startsWith(resolve(tmpdir(), 'codestudio-supervisor-facts-').toLowerCase())) throw new Error('Unsafe fixture cleanup');
    await rm(f.directory, { recursive: true, force: true });
  }
});

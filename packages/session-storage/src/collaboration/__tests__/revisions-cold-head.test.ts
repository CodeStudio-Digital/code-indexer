import { describe, expect, it, vi } from 'vitest';
import { CollaborationRevisions } from '../revisions.js';
describe('Collaboration revision cold start', () => {
  it('finds a long contiguous journal without reading its entire history', async () => {
    const get = vi.fn(async (_kind: string, key: string) => {
      const revision = Number(key.split(':').at(-1));
      return revision <= 10_003 ? { schemaVersion: 1, revision, operationId: `op-${revision}`, value: { latest: revision } } : null;
    });
    const revisions = new CollaborationRevisions({ get } as never);
    expect((await revisions.read<{ latest: number }>('claims', 'shared'))?.value.latest).toBe(10_003);
    expect(get.mock.calls.length).toBeLessThan(35);
  });
});

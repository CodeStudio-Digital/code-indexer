/**
 * RoutingVectorStore (R2 flip) routes purely by namespace — no ABI needed, the
 * central + per-project stores and the db are mocked. Confirms `code:<name>`
 * ops hit the per-project store while docs (`docs:*`) and snapshot ops (NO
 * namespace) stay central, and that flag-off / unknown project falls back to
 * central.
 */
import { describe, it, expect, vi } from 'vitest';
import { RoutingVectorStore } from '../vectors-routing.js';
import type { VectorStore } from '../vectors.js';
import type { CodeIndexDB } from '../db.js';

function fakeStore(tag: string): VectorStore & { tag: string } {
  return {
    tag,
    upsert: vi.fn(async () => 1),
    search: vi.fn(async () => [{ id: tag, score: 1, metadata: {} }]),
    deleteByIds: vi.fn(async () => 1),
    deleteNamespace: vi.fn(async () => 1),
    isAvailable: vi.fn(async () => true),
  };
}

function makeDb(opts: { projectStore: VectorStore | null; knownName?: string }): CodeIndexDB {
  return {
    getProjectByName: (name: string) => (name === (opts.knownName ?? 'p1') ? { id: 7, name } : undefined),
    codeVectorStoreFor: (_id: number, central: VectorStore | null) => opts.projectStore ?? central,
  } as unknown as CodeIndexDB;
}

describe('RoutingVectorStore (R2)', () => {
  it('routes code:<name> to the per-project store, everything else to central', async () => {
    const central = fakeStore('central');
    const project = fakeStore('project');
    const r = new RoutingVectorStore(central, makeDb({ projectStore: project }));

    await r.upsert([{ id: 'file::1', values: [1], metadata: {} }], 'code:p1');
    await r.search([1], { namespace: 'code:p1' });
    await r.deleteByIds(['file::1'], 'code:p1');
    expect(project.upsert).toHaveBeenCalledOnce();
    expect(project.search).toHaveBeenCalledOnce();
    expect(project.deleteByIds).toHaveBeenCalledOnce();
    expect(central.upsert).not.toHaveBeenCalled();

    // Docs namespace → central.
    await r.upsert([{ id: 'doc::1', values: [1], metadata: {} }], 'docs:c5');
    // Snapshot op → NO namespace → central.
    await r.upsert([{ id: 'snap::1', values: [1], metadata: {} }]);
    await r.deleteByIds(['snap::1']); // snapshot delete, no namespace
    expect(central.upsert).toHaveBeenCalledTimes(2);
    expect(central.deleteByIds).toHaveBeenCalledOnce();
    expect(project.upsert).toHaveBeenCalledOnce(); // unchanged
  });

  it('falls back to central when the project is unknown or not routed', async () => {
    const central = fakeStore('central');
    // codeVectorStoreFor returns central (flag off / not migrated / remote backend).
    const r = new RoutingVectorStore(central, makeDb({ projectStore: null }));
    await r.search([1], { namespace: 'code:p1' });
    expect(central.search).toHaveBeenCalledOnce();

    // Unknown project name → central (getProjectByName returns undefined).
    const r2 = new RoutingVectorStore(central, makeDb({ projectStore: fakeStore('project'), knownName: 'other' }));
    await r2.upsert([{ id: 'x', values: [1], metadata: {} }], 'code:ghost');
    expect(central.upsert).toHaveBeenCalledOnce();
  });

  it('exposes the central store for diag unwrap', () => {
    const central = fakeStore('central');
    const r = new RoutingVectorStore(central, makeDb({ projectStore: null }));
    expect(r.central).toBe(central);
  });
});

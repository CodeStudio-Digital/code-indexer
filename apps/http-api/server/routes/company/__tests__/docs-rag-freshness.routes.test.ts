import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpRouter } from '@mcp/shared/http/router.js';
import type { ServerDeps } from '../../../deps.js';
const fixture = vi.hoisted(() => ({ content: 'first', ingest: vi.fn(), source: { id: 2, status: 'done', last_indexed_at: '2026-11-04', content_hash: 'first', uri: 'companydoc://session:company/main/adr.md' } }));
vi.mock('../../_helpers.js', () => ({
  parseCompanySessionIdParam: () => 'company', parseJsonBody: (c: { req: { json(): Promise<unknown> } }) => c.req.json(),
  resolveCompanySessionContext: async () => ({ rootId: 'company', root: { project_ids: [7, 9] } }),
  notFound: vi.fn(),
}));
vi.mock('../docs.js', () => ({
  normalizeDocServiceId: (service: string | null) => service || 'main', resolveDocsScopeKey: () => 'session:company',
  readCompanyDoc: async () => fixture.content === '' ? null : ({ content: fixture.content, version: fixture.content, origin: 'drive_mirror' }),
}));
vi.mock('@mcp/services/services/docs/index-doc-use-case/run-ingest.js', () => ({ runIngest: (...args: unknown[]) => fixture.ingest(...args) }));
import { mountCompanyDocsRagRoutes } from '../docs-rag.js';

function setup() {
  const store = {
    getCollectionByName: () => ({ id: 1 }), listSourcesByCollection: () => [fixture.source],
    linkProjectCollection: vi.fn(), updateSourceStats: vi.fn((_id: number, patch: object) => Object.assign(fixture.source, patch)),
    listVectorIdsForSource: () => [], replaceChunksForSource: vi.fn(), deleteSemanticItemsByVectorIds: vi.fn(), updateSourceStatus: vi.fn(),
  };
  const app = new HttpRouter();
  mountCompanyDocsRagRoutes(app, { sessionStore: {}, docStore: store, indexDocsUseCase: { runWithSemanticCollection: async (_id: number, work: () => Promise<unknown>) => work() } } as unknown as ServerDeps);
  return { app, store };
}
beforeEach(() => {
  fixture.content = 'first'; fixture.source.content_hash = 'first';
  fixture.ingest.mockReset().mockResolvedValue({ chunks_indexed: 1 });
});
describe('Company knowledge RAG version contract', () => {
  it('marks changed and deleted documents stale instead of indexed', async () => {
    const { app } = setup();
    const status = async () => (await app.request('/api/company/sessions/company/docs/rag-status?path=adr.md')).json();
    expect(await status()).toMatchObject({ indexed: true, stale: false });
    fixture.content = 'changed';
    expect(await status()).toMatchObject({ indexed: false, stale: true, deleted: false });
    fixture.content = '';
    expect(await status()).toMatchObject({ indexed: false, stale: true, deleted: true });
  });
  it('reindexes the current version and links every project', async () => {
    const { app, store } = setup(); fixture.content = 'second';
    const response = await app.request('/api/company/sessions/company/docs/index-rag', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: 'adr.md' }) });
    expect(response.status).toBe(200);
    expect(store.linkProjectCollection.mock.calls).toEqual([[7, 1, 'auto'], [9, 1, 'auto']]);
    expect(fixture.source.content_hash).toBe('second');
  });
  it('invalidates a stale ingest completed after a concurrent document edit', async () => {
    const { app, store } = setup();
    fixture.ingest.mockImplementation(async () => { fixture.content = 'newer'; return { chunks_indexed: 1 }; });
    const response = await app.request('/api/company/sessions/company/docs/index-rag', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ path: 'adr.md' }) });
    expect(response.status).toBe(500);
    expect(store.replaceChunksForSource).toHaveBeenCalledWith(2, []);
    expect(fixture.source.content_hash).toBeNull();
  });
});

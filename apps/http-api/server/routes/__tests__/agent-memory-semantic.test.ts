import { describe, expect, it, vi } from 'vitest';
import { HttpRouter } from '@mcp/shared/http/router.js';
import { mountAgentMemorySemanticRoutes, memorySemanticFailureCode } from '../agent-memory-semantic.js';
import type { ServerDeps } from '../../deps.js';

vi.mock('@mcp/store/db/agent-memory-coverage.js', () => ({ readAgentMemoryCoverage: (_db: unknown, pid: number, scope: string) => ({
  namespace: scope === 'user' ? 'memory:user' : `memory:project:p${pid}`, generationId: 7,
  live: 3, indexed: 1, failed: 1, missing: 1, pending: 0, queuedMutations: 0,
}) }));
function fixture(kind = 'provider') {
  let finish!: () => void;
  const wait = new Promise<void>(resolve => { finish = resolve; });
  const deps = { db: { getProject: vi.fn((id:number) => id===7 ? {id} : null), raw: () => ({}) },
    semanticStore: { getProfile: vi.fn(() => ({ embedding_target: {kind} })), listNamespaceGenerations: () => [],
      getNamespaceBuildRetry: () => null, listJobs: vi.fn(() => [] as Array<{error:string}>),
      getJob: vi.fn(() => ({id:1,status:'pending'})), updateJob: vi.fn(), noteNamespaceMutation: vi.fn(() => ({id:1})) },
    semanticCoordinator: { ensureMemoryNamespace: vi.fn(() => wait) } };
  const app = new HttpRouter(); mountAgentMemorySemanticRoutes(app, deps as unknown as ServerDeps);
  return { app, deps, finish };
}
const post = (body: unknown) => ({method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
describe('memory semantic diagnostics and explicit scoped repair', () => {
  it('reads coverage without invoking inference or enqueuing work', async () => {
    const {app,deps}=fixture(); const res=await app.request('/api/projects/7/agent-memory/semantic');
    expect(res.status).toBe(200); expect(await res.json()).toMatchObject({enabled:true,remote:true,project:{live:3,indexed:1},user:{namespace:'memory:user'}});
    expect(deps.semanticStore.noteNamespaceMutation).not.toHaveBeenCalled();
    expect(deps.semanticCoordinator.ensureMemoryNamespace).not.toHaveBeenCalled();
  });
  it('requires explicit remote acknowledgement and validates project and scope', async () => {
    const {app,deps}=fixture();
    expect((await app.request('/api/projects/7/agent-memory/semantic/repair',post({scope:'project'}))).status).toBe(409);
    expect((await app.request('/api/projects/7/agent-memory/semantic/repair',post({scope:'all',confirmRemote:true}))).status).toBe(400);
    expect((await app.request('/api/projects/8/agent-memory/semantic/repair',post({scope:'project',confirmRemote:true}))).status).toBe(404);
    expect(deps.semanticStore.noteNamespaceMutation).not.toHaveBeenCalled();
  });
  it('coalesces concurrent explicit repairs and never starts a global reindex', async () => {
    const {app,deps,finish}=fixture();
    try {
      expect((await app.request('/api/projects/7/agent-memory/semantic/repair',post({scope:'project',confirmRemote:true}))).status).toBe(202);
      const again=await app.request('/api/projects/7/agent-memory/semantic/repair',post({scope:'project',confirmRemote:true}));
      expect(await again.json()).toMatchObject({alreadyRunning:true});
      expect(deps.semanticStore.noteNamespaceMutation).toHaveBeenCalledTimes(1);
      expect(deps.semanticCoordinator.ensureMemoryNamespace).toHaveBeenCalledExactlyOnceWith('memory:project:p7',true,expect.any(Function));
    } finally { finish(); }
  });
  it('allows an explicit local repair without remote acknowledgement', async () => {
    const {app,deps,finish}=fixture('onnx');
    try { expect((await app.request('/api/projects/7/agent-memory/semantic/repair',post({scope:'user'}))).status).toBe(202);
      expect(deps.semanticCoordinator.ensureMemoryNamespace).toHaveBeenCalledWith('memory:user',true,expect.any(Function));
    } finally { finish(); }
  });
  it('classifies native failure without returning the raw message', () => {
    expect(memorySemanticFailureCode('Não foi possível encontrar o módulo especificado.')).toBe('runtime_unavailable');
    expect(memorySemanticFailureCode('401 token=private')).toBe('authentication');
    expect(memorySemanticFailureCode('authentication')).toBe('authentication');
  });
  it('persists pre-generation failures and surfaces them without raw provider text', async () => {
    const {app,deps}=fixture('onnx');
    deps.semanticCoordinator.ensureMemoryNamespace.mockRejectedValueOnce(new Error('semantic vector worker unavailable: generation build'));
    await app.request('/api/projects/7/agent-memory/semantic/repair',post({scope:'project'}));
    await vi.waitFor(() => expect(deps.semanticStore.updateJob).toHaveBeenCalledWith(1,{status:'paused',error:'runtime_unavailable'}));
    deps.semanticStore.listJobs.mockReturnValue([{error:'runtime_unavailable'}]);
    expect(await (await app.request('/api/projects/7/agent-memory/semantic')).json())
      .toMatchObject({project:{errorCode:'runtime_unavailable',repairing:false}});
  });
  it('binds approval to the original target and leaves a durable explicit-repair marker', async () => {
    const {app,deps,finish}=fixture('onnx');
    try {
      await app.request('/api/projects/7/agent-memory/semantic/repair',post({scope:'project'}));
      const guard=(deps.semanticCoordinator.ensureMemoryNamespace.mock.calls[0] as unknown as [string,boolean,()=>void])[2];
      expect(guard).not.toThrow();
      deps.semanticStore.getProfile.mockReturnValue({embedding_target:{kind:'provider'}});
      expect(guard).toThrow('memory_semantic_target_changed');
      expect(deps.semanticStore.noteNamespaceMutation).toHaveBeenCalledWith(expect.objectContaining({requiresExplicitReindex:true}));
    } finally { finish(); }
  });
  it('keeps failed repair visible when diagnostic persistence is busy', async () => {
    const {app,deps}=fixture('onnx');
    deps.semanticCoordinator.ensureMemoryNamespace.mockRejectedValueOnce(new Error('worker unavailable'));
    deps.semanticStore.updateJob.mockImplementationOnce(() => { throw new Error('SQLITE_BUSY'); });
    await app.request('/api/projects/7/agent-memory/semantic/repair',post({scope:'project'}));
    await vi.waitFor(() => expect(deps.semanticStore.updateJob).toHaveBeenCalled());
    expect(await (await app.request('/api/projects/7/agent-memory/semantic')).json())
      .toMatchObject({project:{errorCode:'embedding_failed',repairing:false}});
  });
});

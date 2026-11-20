import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '@mcp/shared/types.js';
import type { ToolContext } from '../../context.js';
import { projectTools } from '@mcp/indexer/agent-tools/tools/projects.js';
import { miscTools } from '@mcp/indexer/agent-tools/tools/misc.js';
import { fileTools } from '@mcp/indexer/agent-tools/tools/file.js';
import { index_project } from '../index-project.js';
import { projectResources } from '../../resources/projects.js';

const project = {
  id: 7,
  name: 'demo',
  root_path: 'D:/demo',
  structural_indexed_at: '2026-07-15 10:00:00',
  structural_last_checked_at: '2026-07-15 10:01:00',
} as Project;

function context(): ToolContext {
  const file = {
    id: 11,
    project_id: 7,
    path: 'src/index.ts',
    language: 'typescript',
    line_count: 10,
    size: 240,
    content_hash: 'hash',
    summary: 'retired summary',
    concepts: '["retired"]',
    layer: 'business',
    complexity: 'high',
  };
  const db = {
    getProjectByPath: () => project,
    getProjectByName: () => project,
    listProjects: () => [project],
    getStats: () => ({
      file_count: 1,
      symbol_count: 1,
      total_lines: 10,
      languages: { typescript: 1 },
    }),
    listFiles: () => [file],
    listSnapshots: () => [],
    getAgentProjectShape: () => ({ topDirectories: [{ path: 'src', files: 1 }], keyFiles: [file.path] }),
    countSnapshots: () => 0,
    getFile: () => file,
    getAgentFileSkeleton: () => ({ file, files: 1, total: 1, offset: 0,
      symbols: [{ file_path: file.path, line: 1, kind: 'function', parent: null, name: 'main', signature: 'main()', stable_id: 's1' }] }),
    getSymbolsByFile: () => [{
      line: 1,
      kind: 'function',
      parent: null,
      name: 'main',
      signature: 'main()',
      stable_id: 's1',
    }],
  };
  return {
    config: { dashboard: { host: '127.0.0.1', port: 7333 } },
    db,
    semanticStore: {
      listNamespaceGenerations: () => [{
        namespace: 'code:p7',
        active_generation_id: 12,
        building_generation_id: null,
        expected_items: 5,
        indexed_items: 5,
        failed_items: 0,
        delta_items: 0,
        last_error: null,
      }],
      getProfile: () => ({ embedding_target: { kind: 'onnx' } }),
    },
  } as unknown as ToolContext;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('retired project indexer surfaces', () => {
  it('cancels the in-flight owner request and does not schedule semantic work', async () => {
    const abort = new AbortController();
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason), { once: true });
    }));
    vi.stubGlobal('fetch', fetchMock);
    const ctx = context(); ctx.signal = abort.signal;
    const pending = Promise.resolve(index_project.handler({ project_path: 'D:/demo' }, ctx));
    const rejected = expect(pending).rejects.toThrow('stopped');
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledOnce());
    abort.abort(new Error('stopped')); await rejected;
    expect(fetchMock).toHaveBeenCalledOnce();
  });
  it('marks an unconfirmed semantic write as uncertain instead of claiming it never started', async () => {
    const fetchMock = vi.fn().mockResolvedValueOnce(Response.json({ ok: true, status: { phase: 'ready' } }))
      .mockRejectedValueOnce(new Error('connection lost after commit'));
    vi.stubGlobal('fetch', fetchMock);
    const result = await index_project.handler({ project_path: 'D:/demo' }, context());
    expect(result).toMatchObject({ effectOutcome: 'unknown' });
    expect(JSON.stringify(result)).not.toContain('was not started');
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
  it('routes index_project through structural and semantic owner APIs', async () => {
    const fetchMock = vi.fn(async (url: string, _init?: RequestInit) => {
      if (url.endsWith('/index/structural/reconcile')) {
        return new Response(JSON.stringify({ ok: true, status: { phase: 'ready' } }), {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      return new Response(JSON.stringify({ ok: true, job: { id: 91, status: 'pending' } }), {
        status: 202,
        headers: { 'content-type': 'application/json' },
      });
    });
    vi.stubGlobal('fetch', fetchMock);
    const tool = index_project;

    const output = await tool.handler({ project_path: 'D:/demo' }, context());

    expect(Object.keys(tool.inputSchema.properties)).toEqual(['project_path', 'rebuild_semantic']);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      'http://127.0.0.1:7333/api/projects/7/index/structural/reconcile',
      'http://127.0.0.1:7333/api/projects/7/semantic/reindex',
    ]);
    expect(fetchMock.mock.calls[1][1]).toMatchObject({
      body: JSON.stringify({ action: 'start' }),
    });
    expect(output).toContain('job #91');
    expect(output).not.toContain('Cost:');
  });

  it('does not publish obsolete run diff or indexing-cost estimators', () => {
    expect(miscTools.map((tool) => tool.name)).not.toEqual(
      expect.arrayContaining(['get_diff', 'estimate_cost']),
    );
  });

  it('keeps overview and file payloads structural even when legacy columns exist', async () => {
    const ctx = context();
    const pulse = projectTools.find((entry) => entry.name === 'get_project_pulse')!;
    const skeleton = fileTools.find((entry) => entry.name === 'get_file_skeleton')!;
    const pulseResult = await pulse.handler({ project_name: 'demo', format: 'json' }, ctx);
    const skeletonResult = await skeleton.handler({
      project_name: 'demo', file_path: 'src/index.ts', format: 'json',
    }, ctx);
    const pulsePayload = JSON.parse(typeof pulseResult === 'string' ? pulseResult : pulseResult.text);
    const skeletonPayload = JSON.parse(typeof skeletonResult === 'string' ? skeletonResult : skeletonResult.text);
    const resource = await projectResources[0].read('mcp://project/demo/overview', ctx);
    const resourcePayload = JSON.parse(resource?.[0]?.type === 'text' ? resource[0].text : '{}');

    for (const payload of [pulsePayload, resourcePayload]) {
      expect(payload).not.toHaveProperty('layers');
      expect(payload).not.toHaveProperty('top_concepts');
      expect(payload).not.toHaveProperty('cost');
      expect(payload.semantic).toMatchObject({ state: 'active', active_generation_id: 12 });
    }
    expect(skeletonPayload.file).toEqual(expect.objectContaining({
      path: 'src/index.ts', language: 'typescript', line_count: 10, size_bytes: 240,
    }));
    expect(skeletonPayload.file).not.toHaveProperty('summary');
    expect(skeletonPayload.file).not.toHaveProperty('concepts');
    expect(skeletonPayload.file).not.toHaveProperty('layer');
    expect(skeletonPayload.file).not.toHaveProperty('complexity');
  });
});

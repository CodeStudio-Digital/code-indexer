/**
 * Index tools keep structural payloads and do not publish retired surfaces.
 * These are the cases of the deleted MCP server test
 * apps/mcp-server/tools/__tests__/legacy-index-cleanup.test.ts that still
 * test live code; the index_project and project-resource checks went away
 * with the server.
 */
import { describe, expect, it } from 'vitest';
import type { Project } from '@mcp/shared/types.js';
import type { IndexToolContext } from '../../context.js';
import { projectTools } from '../projects.js';
import { miscTools } from '../misc.js';
import { fileTools } from '../file.js';

const project = {
  id: 7,
  name: 'demo',
  root_path: 'D:/demo',
  structural_indexed_at: '2026-07-15 10:00:00',
  structural_last_checked_at: '2026-07-15 10:01:00',
} as Project;

function context(): IndexToolContext {
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
  } as unknown as IndexToolContext;
}

describe('retired project indexer surfaces', () => {
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

    for (const payload of [pulsePayload]) {
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

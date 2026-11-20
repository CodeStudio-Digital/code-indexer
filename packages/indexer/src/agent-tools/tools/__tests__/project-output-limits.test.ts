import { describe, expect, it } from 'vitest';
import type { Project } from '@mcp/shared/types.js';
import type { IndexToolContext } from '../../context.js';
import { truncateToTokens, truncateToTokensDetailed } from '../../utils.js';
import { projectTools } from '../projects.js';

const project = {
  id: 17,
  name: 'large-project',
  root_path: 'D:/large-project',
  structural_indexed_at: '2026-07-16 10:00:00',
  structural_last_checked_at: '2026-07-16 10:01:00',
} as Project;

function context(fileCount: number): IndexToolContext {
  const files = Array.from({ length: fileCount }, (_, index) => ({
    id: index + 1,
    project_id: project.id,
    path: `src/module-${String(index).padStart(3, '0')}.ts`,
    language: 'typescript',
    line_count: 20,
    size: 400,
    content_hash: `hash-${index}`,
    is_entry_point: 0,
  }));
  return {
    db: {
      getProjectByName: () => project,
      getStats: () => ({
        file_count: fileCount,
        symbol_count: fileCount,
        total_lines: fileCount * 20,
        languages: { typescript: fileCount },
      }),
      listFiles: () => files,
      listAgentRepoMap: (_id: number, { offset = 0, limit = 100 }) => ({ items: files.slice(offset, offset + limit).map(f => ({
        id: f.id, path: f.path, score: 1, is_entry_point: 0, dependent_count: 0, symbol_count: 1,
        symbols: [{ name: 'create', kind: 'function', signature: 'create()', signature_characters: 8, line: 1 }],
      })), total: files.length, offset, ...(offset + limit < files.length ? { nextOffset: offset + limit } : {}) }),
      listSnapshots: () => [],
      listAgentIndexFiles: (_id: number, { offset = 0, limit = 200 }) => ({ items: files.slice(offset, offset + limit), total: files.length, offset, ...(offset + limit < files.length ? { nextOffset: offset + limit } : {}) }),
      getAgentProjectShape: () => ({ topDirectories: [{ path: 'src', files: files.length }], keyFiles: files.slice(0, 8).map(f => f.path) }),
      countSnapshots: () => 0,
      getDependents: () => [],
      getSymbolsByFile: (_projectId: number, path: string) => [{
        name: `create${path.replace(/\W/g, '')}`,
        kind: 'function',
        signature: `export function create${path.replace(/\W/g, '')}(): void`,
      }],
    },
    semanticStore: {
      listNamespaceGenerations: () => [],
      getProfile: () => ({ embedding_target: { kind: 'disabled' } }),
    },
  } as unknown as IndexToolContext;
}

describe('MCP project output limits', () => {
  it('reports the compact default file cap and recovers by raising max_files', async () => {
    const tool = projectTools.find((candidate) => candidate.name === 'get_project_overview')!;
    const ctx = context(60);

    const compact = await tool.handler({ project_name: project.name, compact: true }, ctx);
    const expanded = await tool.handler({
      project_name: project.name,
      compact: true,
      max_files: 60,
    }, ctx);

    expect(typeof compact).toBe('object');
    if (typeof compact === 'string') throw new Error('Expected structured MCP result');
    expect(compact.sourceTruncations).toEqual([{
      technique: 'mcp-project-overview-file-limit',
      inputSize: 60,
      outputSize: 50,
      unit: 'items',
      recoverable: true,
    }]);
    expect(compact.text).toContain('10 more files omitted');
    expect(typeof expanded).toBe('string');
    expect(expanded).toContain('module-059.ts');
  });

  it('returns the full overview by default and proves explicit token-budget omission', async () => {
    const tool = projectTools.find((candidate) => candidate.name === 'get_project_overview')!;
    const ctx = context(80);

    const complete = await tool.handler({ project_name: project.name }, ctx);
    const limited = await tool.handler({ project_name: project.name, max_tokens: 20 }, ctx);

    expect(typeof complete).toBe('string');
    expect(complete).toContain('module-079.ts');
    expect(typeof limited).toBe('object');
    if (typeof limited === 'string') throw new Error('Expected structured MCP result');
    expect(limited.text).toContain('rerun without max_tokens');
    expect(limited.sourceTruncations).toEqual([
      expect.objectContaining({
        technique: 'mcp-project-overview-token-budget',
        outputSize: 80,
        unit: 'chars',
        recoverable: true,
      }),
    ]);
    expect(limited.sourceTruncations![0].inputSize).toBeGreaterThan(80);
  });

  it('reports repo-map file paging and an explicit token budget independently', async () => {
    const tool = projectTools.find((candidate) => candidate.name === 'get_repo_map')!;
    const ctx = context(300);

    const complete = await tool.handler({ project_name: project.name, limit: 300 }, ctx);
    const limited = await tool.handler({ project_name: project.name, max_tokens: 100 }, ctx);

    expect(typeof complete).toBe('string');
    if (typeof complete !== 'string') throw new Error('Expected complete string result');
    expect(complete.length).toBeGreaterThan(8_000);
    expect(complete).toContain('module-299.ts');
    expect(typeof limited).toBe('object');
    if (typeof limited === 'string') throw new Error('Expected structured MCP result');
    expect(limited.sourceTruncations).toEqual([{
      technique: 'mcp-repo-map-file-page', inputSize: 300, outputSize: 100, unit: 'items', recoverable: true,
    }, {
      technique: 'mcp-repo-map-token-budget',
      inputSize: expect.any(Number),
      outputSize: 400,
      unit: 'chars',
      recoverable: true,
    }]);
  });

  it('keeps the string helper compatible and never splits a surrogate pair', () => {
    const detailed = truncateToTokensDetailed('abc😀tail', 1);

    expect(detailed.retainedChars).toBe(3);
    expect(detailed.text.startsWith('abc\n\n...')).toBe(true);
    expect(detailed.text).not.toContain('\uFFFD');
    expect(typeof truncateToTokens('long text', 1)).toBe('string');
  });
});

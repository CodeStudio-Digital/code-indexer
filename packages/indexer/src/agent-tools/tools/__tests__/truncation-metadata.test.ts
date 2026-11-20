import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Project } from '@mcp/shared/types.js';
import type { IndexToolContext } from '../../context.js';
import type { McpToolResult } from '../../tool.js';
import { fileTools, listDirectoryFromDisk } from '../file.js';
import { scanDiskForGrepDetailed, searchTools } from '../search.js';
import { symbolTools } from '../symbols.js';

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'mcp-trunc-meta-'));
  roots.push(root);
  return root;
}

function project(rootPath: string): Project {
  return { id: 7, name: 'demo', root_path: rootPath } as Project;
}

function context(rootPath: string, db: Record<string, unknown>): IndexToolContext {
  const p = project(rootPath);
  return {
    db: {
      getProjectByName: () => p,
      ...db,
    },
  } as unknown as IndexToolContext;
}

function normalized(result: McpToolResult): Exclude<McpToolResult, string> {
  return typeof result === 'string' ? { text: result } : result;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('MCP producer truncation metadata', () => {
  it('counts every directory file before applying get_file_skeleton max_symbols', async () => {
    const root = tempRoot();
    const files = Array.from({ length: 45 }, (_, index) => ({
      path: `src/f${String(index).padStart(2, '0')}.ts`,
    }));
    const ctx = context(root, {
      getFile: () => undefined,
      getAgentFileSkeleton: (_id: number, _path: string, page: { offset: number; limit: number }) => ({
        file: undefined, files: files.length, total: files.length, offset: page.offset, nextOffset: page.offset + page.limit,
        symbols: files.slice(page.offset, page.offset + page.limit).map(f => ({ file_path: f.path,
          line: 1, kind: 'function', parent: null, name: `fn_${f.path}`, signature: '()', stable_id: null })),
      }),
      listFiles: () => files,
      getSymbolsByFile: (_projectId: number, path: string) => [{
        line: 1,
        kind: 'function',
        parent: null,
        name: `fn_${path}`,
        signature: '()',
        exported: 1,
      }],
    });
    const tool = fileTools.find((entry) => entry.name === 'get_file_skeleton')!;

    const result = normalized(await tool.handler({
      project_name: 'demo', file_path: 'src', max_symbols: 5, format: 'json',
    }, ctx));
    const payload = JSON.parse(result.text) as { files_in_dir: number; total_symbols: number; shown_symbols?: number };

    expect(payload).toMatchObject({ files_in_dir: 45, total_symbols: 45 });
    expect(result.sourceTruncations).toEqual([expect.objectContaining({
      technique: 'mcp-file-skeleton-symbol-cap', inputSize: 45, outputSize: 5, recoverable: true,
    })]);
  });

  it('probes one extra grep hit and reports a lower-bound result cap', async () => {
    const root = tempRoot();
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'many.ts'), Array.from({ length: 8 }, (_, i) => `needle ${i}`).join('\n'));
    const ctx = context(root, {
      listFilePathsBounded: () => ({ paths: ['src/many.ts'], truncated: false }),
      searchFileContents: () => [],
    });
    const tool = searchTools.find((entry) => entry.name === 'grep_code')!;

    const result = normalized(await tool.handler({
      project_name: 'demo', pattern: 'needle', literal: true, max_results: 2,
    }, ctx));

    expect(result.text).toContain('showing 2 results; at least 3 matched');
    expect(result.sourceTruncations).toEqual([expect.objectContaining({
      technique: 'mcp-grep-result-cap', inputSize: 3, inputSizeExact: false, outputSize: 2,
    })]);
  });

  it('keeps capped filename hints separate from empty content matches', async () => {
    const root = tempRoot();
    mkdirSync(join(root, 'licenses'), { recursive: true });
    const paths = Array.from({ length: 7 }, (_, index) => `licenses/entry-${index}.ts`);
    for (const path of paths) writeFileSync(join(root, path), 'export const permitted = true;');
    const ctx = context(root, {
      listFilePathsBounded: () => ({ paths, truncated: false }),
      searchFileContents: () => [],
    });
    const tool = searchTools.find(entry => entry.name === 'grep_code')!;
    const result = normalized(await tool.handler({ project_name: 'demo', pattern: 'licenses', literal: true }, ctx));
    expect(result.text).toContain('No content matches');
    expect(result.text).toContain('navigation hints, not content hits; more omitted');
    expect(result.structuredContent).toMatchObject({ hits: [], pathHints: paths.slice(0, 5), pathHintsTruncated: true,
      absenceConclusive: false });
  });

  it('applies one global disk-scan cap across synthetic workspace sources', async () => {
    const root = tempRoot();
    const first = join(root, 'first');
    const second = join(root, 'second');
    mkdirSync(first, { recursive: true });
    mkdirSync(second, { recursive: true });
    for (let index = 0; index < 3; index++) {
      writeFileSync(join(first, `a-${index}.ts`), 'a');
      writeFileSync(join(second, `b-${index}.ts`), 'b');
    }

    const scan = await scanDiskForGrepDetailed(root, undefined, [
      { rootPath: first, prefix: 'first' },
      { rootPath: second, prefix: 'second' },
    ], 4);

    expect(scan).toMatchObject({ totalMatches: 5, totalMatchesExact: false, truncated: true });
    expect(scan.paths).toHaveLength(4);
    expect(scan.paths.filter((path) => path.startsWith('second/'))).toHaveLength(1);
  });

  it('marks a directory scan only for an eligible item beyond the cap', () => {
    const root = tempRoot();
    writeFileSync(join(root, 'a.ts'), 'a');
    writeFileSync(join(root, 'b.ts'), 'b');
    mkdirSync(join(root, 'node_modules'));
    writeFileSync(join(root, 'node_modules', 'ignored.ts'), 'ignored');
    let truncated = false;

    expect(listDirectoryFromDisk(root, '', 1, undefined, () => { truncated = true; }, 2)).toHaveLength(2);
    expect(truncated).toBe(false);

    writeFileSync(join(root, 'c.ts'), 'c');
    listDirectoryFromDisk(root, '', 1, undefined, () => { truncated = true; }, 2);
    expect(truncated).toBe(true);
  });

  it('reports caller and test caps from prepare_edit with exact totals', async () => {
    const root = tempRoot();
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(join(root, 'src', 'target.ts'), 'export function target() {}');
    const symbol = {
      id: 1,
      project_id: 7,
      name: 'target',
      kind: 'function',
      file_path: 'src/target.ts',
      line: 1,
      stable_id: 'sym:target',
      signature: 'target()',
    };
    const callers = Array.from({ length: 3 }, (_, index) => ({
      file_path: `src/caller-${index}.ts`, line: index + 1, context: 'target()',
    }));
    const tests = Array.from({ length: 7 }, (_, index) => ({
      source_file_path: `test/target-${index}.test.ts`, import_path: '../src/target',
    }));
    const ctx = context(root, {
      listAgentSymbolDefinitions: () => ({ total: 1, items: [symbol] }),
      listAgentSymbolReferences: (_id: number, _name: string, page: { offset: number; limit: number }) => ({ total: callers.length, items: callers.slice(page.offset, page.offset + page.limit) }),
      getAgentEditContext: () => ({ indexed: true, neighbors: [], imports: { total: 0, items: [] }, tests: { total: tests.length, items: tests.slice(0, 5).map(t => t.source_file_path) } }),
    });
    const tool = symbolTools.find((entry) => entry.name === 'prepare_edit')!;

    const result = normalized(await tool.handler({
      project_name: 'demo', symbol_name: 'target', file_path: 'src/target.ts', max_callers: 1, format: 'json',
    }, ctx));
    const payload = JSON.parse(result.text) as {
      callers: { total: number; shown: number; truncated: boolean };
      tests_covering: string[];
      tests_covering_total: number;
      tests_covering_truncated: boolean;
    };

    expect(payload.callers).toMatchObject({ total: 3, shown: 1, truncated: true });
    expect(payload).toMatchObject({ tests_covering_total: 7, tests_covering_truncated: true });
    expect(payload.tests_covering).toHaveLength(5);
    expect(result.sourceTruncations).toEqual(expect.arrayContaining([
      expect.objectContaining({ technique: 'mcp-prepare-edit-caller-cap', inputSize: 3, outputSize: 1 }),
      expect.objectContaining({ technique: 'mcp-prepare-edit-test-cap', inputSize: 7, outputSize: 5 }),
    ]));
  });

  it('does not claim an exact total when find_references fallback reaches its cap', async () => {
    const root = tempRoot();
    mkdirSync(join(root, 'src'), { recursive: true });
    writeFileSync(
      join(root, 'src', 'callers.ts'),
      Array.from({ length: 60 }, (_, index) => `target(); // ${index}`).join('\n'),
    );
    const ctx = context(root, {
      listAgentSymbolDefinitions: () => ({ items: [], total: 0 }),
      listAgentSymbolReferences: () => ({ items: [], total: 0 }),
      listFiles: () => [{ path: 'src/callers.ts' }],
    });
    const tool = symbolTools.find((entry) => entry.name === 'find_references')!;

    const result = normalized(await tool.handler({
      project_name: 'demo', symbol_name: 'target', format: 'json',
    }, ctx));
    const payload = JSON.parse(result.text) as {
      total?: number;
      total_at_least: number;
      total_exact: boolean;
      truncated: boolean;
      references: unknown[];
    };

    expect(payload).toMatchObject({ total_at_least: 51, total_exact: false, truncated: true });
    expect(payload.total).toBeUndefined();
    expect(payload.references).toHaveLength(50);
    expect(result.sourceTruncations).toEqual([expect.objectContaining({
      technique: 'mcp-find-references-fallback-cap', inputSize: 51, outputSize: 50,
    })]);
  });

  it('aggregates exact per-node omissions from trace_usage', async () => {
    const root = tempRoot();
    const callers = Array.from({ length: 6 }, (_, index) => ({
      file: `src/caller-${index}.ts`, line: index + 1, symbols_in_file: [], callers: [],
    }));
    const ctx = context(root, {
      traceSymbolUsage: () => ({ symbol: 'target', defined_in: 'src/target.ts:1', callers: callers.slice(0, 5),
        truncations: [{ symbol: 'target', total: 6, shown: 5, reason: 'breadth_limit' }], visited_nodes: 5, max_depth: 3, definition_count: 1 }),
    });
    const tool = symbolTools.find((entry) => entry.name === 'trace_usage')!;

    const result = normalized(await tool.handler({ project_name: 'demo', symbol_name: 'target' }, ctx));

    expect(result.sourceTruncations).toEqual([expect.objectContaining({
      technique: 'mcp-trace-usage-per-node-cap', inputSize: 6, outputSize: 5, recoverable: true,
    })]);
  });

  it('attaches ambiguity metadata to get_symbol_body JSON candidates', async () => {
    const root = tempRoot();
    const candidates = Array.from({ length: 12 }, (_, index) => ({
      id: index + 1,
      project_id: 7,
      name: 'target',
      kind: 'function',
      file_path: `src/target-${index}.ts`,
      line: 1,
      stable_id: `target:${index}`,
    }));
    const ctx = context(root, { listAgentSymbolDefinitions: (_id: number, _name: string, _path: string | undefined, page: { offset: number; limit: number }) => ({
      items: candidates.slice(page.offset, page.offset + page.limit), total: candidates.length,
    }) });
    const tool = symbolTools.find((entry) => entry.name === 'get_symbol_body')!;

    const result = normalized(await tool.handler({
      project_name: 'demo', symbol_name: 'target', format: 'json',
    }, ctx));
    const payload = JSON.parse(result.text) as { total: number; candidates: unknown[] };

    expect(payload.total).toBe(12);
    expect(payload.candidates).toHaveLength(10);
    expect(result.sourceTruncations).toEqual([expect.objectContaining({
      technique: 'mcp-symbol-body-ambiguity-candidate-cap', inputSize: 12, outputSize: 10,
    })]);
  });
});

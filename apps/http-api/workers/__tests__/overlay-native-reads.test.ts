/**
 * A file edited on disk after indexing and marked dirty in the session
 * overlay must read correctly through the shared adapter: current disk
 * content, the current symbol body, grep hits for the new text that respect
 * glob, language and max_results, a current outline, and a directory listing
 * that adds unindexed session files once. The index is a stale fake whose
 * answers mirror the store's queries (packages/store/src/db/agent-symbol-reads.ts,
 * agent-index-reads.ts, files.ts); no database is opened.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { CodeIndexDB } from '@mcp/store/db.js';
import { indexCoreTools } from '@mcp/indexer/agent-tools/index.js';
import { callIndexTool } from '@mcp/indexer/agent-tools/invoke.js';
import { createIndexToolsPort } from '@mcp/indexer/agent-tools/port.js';
import type { IndexerConfig } from '@mcp/shared/utils/config.js';
import type { CoderTool, ToolContext } from '@mcp/code-agent/core/tool.js';
import { buildNativeIndexTools } from '@mcp/code-agent/tools/native-index-tools.js';
import { SessionOverlay } from '@mcp/code-agent/overlay/session-overlay.js';

const EDITED = "// header\nexport function renamed() {\n  return 'NEW_TEXT';\n}\nexport const VALUE = 1;\nexport function alsoNew() {\n  return 2;\n}\n";
/** Indexed paths and their (stale) symbols; src/gone.ts is indexed but no longer on disk. */
const INDEX: Record<string, Array<{ name: string; kind: string; line: number; exported: boolean }>> = {
  'docs/a.md': [],
  'src/edited.ts': [{ name: 'oldName', kind: 'function', line: 1, exported: true }],
  'src/gone.ts': [{ name: 'gone', kind: 'function', line: 1, exported: true }],
  'src/other.ts': [{ name: 'A', kind: 'constant', line: 1, exported: true }],
};
const language = (path: string) => path.endsWith('.ts') ? 'typescript' : 'markdown';
let root: string;
let tools: Map<string, CoderTool>;

function staleIndex(project: { id: number }) {
  const paths = Object.keys(INDEX).sort();
  const symbol = (path: string, s: (typeof INDEX)[string][number]) => ({ file_path: path, line: s.line, end_line: s.line, kind: s.kind,
    name: s.name, signature: `${s.name}()`, parent: null, stable_id: `${path}#${s.name}` });
  const page = <T>(all: T[], input: { offset?: number; limit?: number }) => {
    const offset = input.offset ?? 0, items = all.slice(offset, offset + (input.limit ?? 500));
    return { items, total: all.length, offset, ...(offset + items.length < all.length ? { nextOffset: offset + items.length } : {}) };
  };
  return {
    getProjectByName: () => project, getProject: () => project, getStructuralRevision: () => 'fixture:1',
    getFile: (_projectId: number, path: string) => paths.includes(path) ? { path, language: language(path), line_count: 1 } : undefined,
    listAgentSymbolDefinitions: (_projectId: number, name: string, path: string | undefined, input: { offset: number; limit: number }) =>
      page(paths.filter(p => !path || p === path).flatMap(p => INDEX[p].filter(s => s.name === name).map(s => symbol(p, s))), input),
    listFilePathsBounded: (_projectId: number, lang?: string) => ({ paths: paths.filter(p => !lang || language(p) === lang), truncated: false }),
    searchFileContents: () => [], // the stale indexed content has none of the new text
    // agent-symbol-reads.ts skeletonPage: files = file ? 1 : count under the directory.
    getAgentFileSkeleton: (_projectId: number, path: string, input: { offset: number; limit: number; kind?: string }) => {
      const file = paths.includes(path) ? { path, language: language(path), line_count: 1, size: 30, content_hash: 'old' } : undefined;
      const prefix = path ? path + '/' : '';
      const under = paths.filter(p => p.startsWith(prefix));
      const all = (file ? INDEX[path].map(s => symbol(path, s)) : under.flatMap(p => INDEX[p].filter(s => s.exported).map(s => symbol(p, s))))
        .filter(s => !input.kind || s.kind === input.kind);
      const { items, total, offset, nextOffset } = page(all, input) as { items: unknown[]; total: number; offset: number; nextOffset?: number };
      return { file, files: file ? 1 : under.length, symbols: items, total, offset, ...(nextOffset != null ? { nextOffset } : {}) };
    },
    // agent-index-reads.ts directoryPage: prefix, slash depth and paging in SQL.
    listAgentDirectoryFiles: (_projectId: number, prefix: string, depth: number, input: { offset?: number; limit?: number }) => {
      const base = prefix ? prefix.split('/').length : 0;
      const matching = paths.filter(p => (p === prefix || p.startsWith(prefix ? prefix + '/' : '')) && p.split('/').length - 1 <= depth + base);
      return page(matching.map(path => ({ path, language: language(path), line_count: 1 })), input);
    },
  } as unknown as CodeIndexDB;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'overlay-native-'));
  const write = (path: string, content: string) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), content); };
  write('src/edited.ts', EDITED);
  write('src/other.ts', "export const A = 'NEW_TEXT';\nexport const B = 'NEW_TEXT';\n");
  write('src/new.ts', 'export const created = 1;\n');
  write('docs/a.md', 'NEW_TEXT in docs\n');
  const project = { id: 7, name: 'overlay-project', root_path: root, is_synthetic: 0 };
  const db = staleIndex(project);
  const core = new Map(indexCoreTools.map(tool => [tool.name, tool]));
  const port = {
    // The real port's catalog; calls go to the core over the stale fake index.
    catalog: () => createIndexToolsPort({ config: {} as IndexerConfig }).catalog(),
    invoke: async (name: string, args: Record<string, unknown>, ctx: { signal?: AbortSignal }) =>
      JSON.parse(JSON.stringify(await callIndexTool(core.get(name), name, args, { db, signal: ctx.signal } as never))),
  };
  tools = new Map(buildNativeIndexTools({ port, db, binding: { projectName: project.name, projectRoot: root } }).map(t => [t.name, t]));
}, 30_000);
afterAll(() => rmSync(root, { recursive: true, force: true }));

/** Call a native tool with src/edited.ts (and any extra path) marked dirty. */
async function call(name: string, args: Record<string, unknown>, dirty: string[] = ['src/edited.ts']) {
  const overlay = new SessionOverlay(root);
  for (const path of dirty) overlay.mark(path);
  const result = await tools.get(`mcp__${name}`)!.handler(args, { cwd: root, overlay } as ToolContext);
  return { ...result, text: result.content };
}
const skeleton = async (args: Record<string, unknown>, dirty?: string[]) =>
  JSON.parse((await call('get_file_skeleton', { format: 'json', ...args }, dirty)).text);
type Outline = { symbols?: Array<{ name: string }>; files?: Array<{ symbols: Array<{ name: string }> }> };
/** File outlines list symbols; directory outlines group them per file. */
const names = (json: Outline) => (json.symbols ?? json.files!.flatMap(f => f.symbols)).map(s => s.name);

describe('dirty files read through the index tools without per-tool overlay copies', () => {
  it('read_file returns the disk content and honours symbol and search_term', async () => {
    const whole = await call('read_file', { file_path: 'src/edited.ts' });
    expect(whole.text).toContain("return 'NEW_TEXT';");
    expect(whole.text).not.toContain('[session overlay]');
    const symbol = await call('read_file', { file_path: 'src/edited.ts', symbol: 'renamed' });
    expect(symbol.text).toContain('export function renamed()');
    expect(symbol.text).not.toContain('// header');
    const term = await call('read_file', { file_path: 'src/edited.ts', search_term: 'NEW_TEXT' });
    expect(term.isError).not.toBe(true);
    expect(term.text).toContain("return 'NEW_TEXT';");
  });

  it('get_symbol_body returns the current body from disk', async () => {
    const body = await call('get_symbol_body', { symbol_name: 'renamed', file_path: 'src/edited.ts' });
    expect(body.isError).not.toBe(true);
    expect(body.text).toContain("return 'NEW_TEXT';");
    expect(body.text).not.toContain('[session overlay]');
  });

  it('grep_code finds the new text and respects glob, language and max_results', async () => {
    const all = await call('grep_code', { pattern: 'NEW_TEXT' });
    expect(all.text).toContain('src/edited.ts:3');
    const glob = await call('grep_code', { pattern: 'NEW_TEXT', glob: 'docs/**/*.md' });
    expect(glob.text).toContain('docs/a.md:1');
    expect(glob.text).not.toContain('src/edited.ts');
    const typed = await call('grep_code', { pattern: 'NEW_TEXT', language: 'typescript' });
    expect(typed.text).not.toContain('docs/a.md');
    expect(typed.text).toContain('src/edited.ts:3');
    const capped = await call('grep_code', { pattern: 'NEW_TEXT', glob: 'src/**', max_results: 1 });
    expect(capped.text.match(/^src\/[^:]+:\d+:/gm)).toHaveLength(1);
    expect(capped.sourceTruncations?.some(t => t.technique === 'mcp-grep-result-cap')).toBe(true);
  });

  it('get_file_skeleton outlines an indexed dirty file from disk, never from the index, with kind, offset and format', async () => {
    const text = await call('get_file_skeleton', { file_path: 'src/edited.ts' });
    expect(text.text.split('\n')[0]).not.toMatch(/\| index$/);
    expect(text.text).toContain('renamed');
    expect(text.text).not.toContain('oldName');
    const json = await skeleton({ file_path: 'src/edited.ts' });
    expect(json.source).not.toBe('index');
    expect(names(json)).toEqual(expect.arrayContaining(['renamed', 'alsoNew']));
    expect(names(json)).not.toContain('oldName');
    expect(names(await skeleton({ file_path: 'src/edited.ts', kind: 'function' }))).toEqual(['renamed', 'alsoNew']);
    expect(names(await skeleton({ file_path: 'src/edited.ts', kind: 'function', offset: 1, max_symbols: 1 }))).toEqual(['alsoNew']);
  });

  it('get_file_skeleton keeps the index for a clean file and a directory, and reports a dirty file missing on disk', async () => {
    const clean = await skeleton({ file_path: 'src/edited.ts' }, []);
    expect(clean.source).toBe('index');
    expect(names(clean)).toEqual(['oldName']);
    const directory = await skeleton({ file_path: 'src' }, ['src']); // the mark sends __prefer_disk for a directory path
    expect(directory.directory).toBe('src');
    expect(directory.source).toBe('index');
    expect(names(directory)).toEqual(expect.arrayContaining(['oldName', 'gone', 'A']));
    const gone = await call('get_file_skeleton', { file_path: 'src/gone.ts' }, ['src/gone.ts']);
    expect(gone.isError).toBe(true);
    expect(gone.text).toContain('File "src/gone.ts" not found on disk');
  });

  it('list_directory adds an unindexed session file once, in the listing format, within depth and on the first page', async () => {
    const listed = await call('list_directory', {}, ['src/edited.ts', 'src/new.ts', 'src/deleted.ts']);
    expect(listed.text.match(/src\/edited\.ts/g)).toHaveLength(1);
    expect(listed.text).toContain('src/new.ts [session overlay]');
    expect(listed.text).not.toContain('src/deleted.ts');
    expect((await call('list_directory', { depth: 0 }, ['src/new.ts'])).text).not.toContain('src/new.ts');
    expect((await call('list_directory', { offset: 1 }, ['src/new.ts'])).text).not.toContain('src/new.ts');
  });
});

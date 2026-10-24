import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolContext } from '../../../core/tool.js';
import { LocalFilesystemAdapter } from '../../../ports/filesystem-port.js';
import { diagramCreateTool, diagramUpdateTool } from '../mutate.js';
import { diagramListTool, diagramReadTool } from '../query.js';

let root: string, ctx: ToolContext;
const xml = '<mxGraphModel><root/></mxGraphModel>';
beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'diagram-tools-')); ctx = { cwd: root, projectName: 'diagram-test' } as ToolContext; });
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

it('allows one concurrent creator, reports collisions, and preserves the winning diagram', async () => {
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => diagramCreateTool.handler({ name: 'race', xml, title: `page${i}` }, ctx)));
  const winners = results.map((r, i) => r.isError ? -1 : i).filter(i => i >= 0);
  expect(winners).toHaveLength(1);
  expect(await readFile(join(root, 'diagrams/race.drawio'), 'utf8')).toContain(`name="page${winners[0]}"`);
  expect(results.filter(r => r.isError).every(r => r.content.includes('already exists'))).toBe(true);
});

it('fails closed without an exclusive creation adapter', async () => {
  const port = new LocalFilesystemAdapter();
  Object.defineProperty(port, 'createFile', { value: undefined });
  const write = vi.spyOn(port, 'writeFile');
  const result = await diagramCreateTool.handler({ name: 'new', xml }, { ...ctx, ports: { fs: port } } as ToolContext);
  expect(result.isError).toBe(true); expect(write).not.toHaveBeenCalled();
});

it('cancels before creation and rechecks cancellation after reading update metadata', async () => {
  await expect(diagramCreateTool.handler({ name: 'new', xml }, { ...ctx, signal: AbortSignal.abort(new Error('cancel')) })).rejects.toThrow('cancel');
  const abort = new AbortController(), port = new LocalFilesystemAdapter();
  vi.spyOn(port, 'access').mockImplementation(async () => { abort.abort(new Error('revoked')); });
  const write = vi.spyOn(port, 'writeFile');
  await expect(diagramUpdateTool.handler({ name: 'new', xml }, { ...ctx, signal: abort.signal, ports: { fs: port } } as ToolContext)).rejects.toThrow('revoked');
  expect(write).not.toHaveBeenCalled();
});

it('keeps read errors distinct from absence and reads complete valid diagrams', async () => {
  await diagramCreateTool.handler({ name: 'read', xml }, ctx);
  const file = join(root, 'diagrams/read.drawio');
  expect((await diagramReadTool.handler({ name: 'read' }, ctx)).content).toBe(await readFile(file, 'utf8'));
  const port = new LocalFilesystemAdapter();
  vi.spyOn(port, 'readFileBounded').mockRejectedValue(Object.assign(new Error('permission denied'), { code: 'EACCES' }));
  const denied = await diagramReadTool.handler({ name: 'read' }, { ...ctx, ports: { fs: port } } as ToolContext);
  expect(denied.isError).toBe(true); expect(denied.content).toContain('permission denied'); expect(denied.content).not.toContain('No diagram');
});

it('rejects oversized files before any unbounded read and propagates cancellation', async () => {
  await mkdir(join(root, 'diagrams'));
  await writeFile(join(root, 'diagrams/large.drawio'), 'a'.repeat(4 * 1024 * 1024 + 1));
  const port = new LocalFilesystemAdapter(), read = vi.spyOn(port, 'readFile');
  const result = await diagramReadTool.handler({ name: 'large' }, { ...ctx, ports: { fs: port } } as ToolContext);
  expect(result.isError).toBe(true); expect(result.content).toContain('exceeds'); expect(read).not.toHaveBeenCalled();
  await expect(diagramReadTool.handler({ name: 'large' }, { ...ctx, signal: AbortSignal.abort(new Error('cancel')) })).rejects.toThrow('cancel');
});

it('pages live directory entries without a full listing or file reads', async () => {
  await mkdir(join(root, 'diagrams'));
  await Promise.all(Array.from({ length: 503 }, (_, i) => writeFile(join(root, `diagrams/${i}.drawio`), xml)));
  await writeFile(join(root, 'diagrams/ignore.txt'), 'not a diagram');
  const port = new LocalFilesystemAdapter(), listing = vi.spyOn(port, 'readdir'), read = vi.spyOn(port, 'readFile');
  const context = { ...ctx, ports: { fs: port } } as ToolContext;
  const first = JSON.parse((await diagramListTool.handler({ limit: 500, format: 'json' }, context)).content);
  const last = JSON.parse((await diagramListTool.handler({ offset: first.next_offset, limit: 500, format: 'json' }, context)).content);
  expect(first.names).toHaveLength(500); expect(last.names).toHaveLength(3);
  expect(new Set([...first.names, ...last.names]).size).toBe(503); expect(last.next_offset).toBeNull();
  expect(listing).not.toHaveBeenCalled(); expect(read).not.toHaveBeenCalled();
  expect((await diagramListTool.handler({ limit: 501 }, context)).isError).toBe(true);
});

it('returns JSON for an empty directory and closes a partially consumed iterator', async () => {
  expect(JSON.parse((await diagramListTool.handler({ format: 'json' }, ctx)).content).names).toEqual([]);
  const port = new LocalFilesystemAdapter(); let closed = false, visited = 0;
  vi.spyOn(port, 'iterateDirectory').mockImplementation(async function* () {
    try { for (let i = 0; i < 10000; i++) { visited++; yield { name: `${i}.drawio`, isFile: () => true, isDirectory: () => false }; } }
    finally { closed = true; }
  });
  await diagramListTool.handler({ limit: 2 }, { ...ctx, ports: { fs: port } } as ToolContext);
  expect(closed).toBe(true); expect(visited).toBe(3);
});

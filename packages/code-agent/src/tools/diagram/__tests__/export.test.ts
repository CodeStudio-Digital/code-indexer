import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, access, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ToolContext } from '../../../core/tool.js';
import { diagramExportTool } from '../export.js';
import { decodeDiagramImage, setDiagramRenderer } from '../render-port.js';

let root: string, ctx: ToolContext;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2i8AAAAASUVORK5CYII=', 'base64');
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'diagram-export-')); await mkdir(join(root, 'diagrams'));
  await writeFile(join(root, 'diagrams/source.drawio'), '<mxGraphModel><root/></mxGraphModel>');
  ctx = { cwd: root, projectName: 'test' } as ToolContext;
});
afterEach(async () => { setDiagramRenderer(null); await rm(root, { recursive: true, force: true }); });

it('waits for rendering, creates exact binary bytes, and preserves existing images', async () => {
  const render = vi.fn(async () => 'data:image/png;base64,' + png.toString('base64'));
  setDiagramRenderer({ render });
  const first = await diagramExportTool.handler({ name: 'source', format: 'png', output_name: 'render' }, ctx);
  expect(first.isError).toBeFalsy(); expect(first.content).toContain('diagrams/render.png');
  expect(await readFile(join(root, 'diagrams/render.png'))).toEqual(png);
  const second = await diagramExportTool.handler({ name: 'source', format: 'png', output_name: 'render' }, ctx);
  expect(second.isError).toBe(true); expect(second.content).toContain('preserved');
  expect(await readFile(join(root, 'diagrams/render.png'))).toEqual(png);
});

it('does not write on cancellation during rendering or invalid renderer output', async () => {
  const stop = new AbortController();
  setDiagramRenderer({ render: async () => { stop.abort(new Error('revoked')); return 'data:image/png;base64,' + png.toString('base64'); } });
  await expect(diagramExportTool.handler({ name: 'source', format: 'png' }, { ...ctx, signal: stop.signal })).rejects.toThrow('revoked');
  await expect(access(join(root, 'diagrams/source.png'))).rejects.toThrow();
  setDiagramRenderer({ render: async () => 'data:image/svg+xml;base64,' + Buffer.from('<svg/>').toString('base64') });
  expect((await diagramExportTool.handler({ name: 'source', format: 'png' }, ctx)).isError).toBe(true);
  await expect(access(join(root, 'diagrams/source.png'))).rejects.toThrow();
});

it('fails clearly when rendering is unavailable and rejects mismatched, malformed or oversized image data', async () => {
  expect((await diagramExportTool.handler({ name: 'source', format: 'svg' }, ctx)).content).toContain('desktop app');
  for (const value of ['', 'data:image/png;base64,%%%%', 'data:image/png;base64,YQ==', 'x'.repeat(12 * 1024 * 1024 + 1)]) {
    expect(() => decodeDiagramImage(value, 'png')).toThrow();
  }
  expect(decodeDiagramImage('data:image/png;base64,' + png.toString('base64'), 'png')).toEqual(png);
});

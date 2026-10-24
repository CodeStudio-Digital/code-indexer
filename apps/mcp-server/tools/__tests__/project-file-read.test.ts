import { afterEach, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, symlinkSync, openSync, closeSync, ftruncateSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readProjectFile } from '../project-file-read.js';
import { readFile } from '../read-file.js';
import { scanPattern } from '../bounded-pattern.js';
import type { ToolContext } from '../../context.js';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'mcp-bounded-read-')); roots.push(root);
  const project = { id: 1, name: 'read-test', root_path: root };
  const ctx = { db: { getProjectByName: () => project, getFile: () => ({ line_count: 1 }) } } as unknown as ToolContext;
  const read = (args: Record<string, unknown>) => readFile.handler({ project_name: project.name, file_path: 'input.ts', ...args }, ctx);
  return { root, read, ctx };
}
const text = (r: Awaited<ReturnType<typeof readFile.handler>>) => typeof r === 'string' ? r : r.text;

it('reads current line counts despite a stale index and preserves full force output and tail recovery', async () => {
  const { root, read } = fixture();
  writeFileSync(join(root, 'input.ts'), Array.from({ length: 1201 }, (_, i) => `line-${i + 1}`).join('\n'));
  const first = await read({ max_lines: 100 });
  expect(first).toMatchObject({ sourceTruncations: [{ inputSize: 1201, outputSize: 100 }] });
  expect(text(first)).toContain('"start_line":101'); expect(text(first)).not.toContain('line-101');
  expect(text(await read({ start_line: 1200 }))).toContain('line-1201');
  expect(text(await read({ force: true }))).toContain('1201\tline-1201');
});

it('preserves UTF-8 across arbitrary byte page boundaries and can recover every raw byte in base64', async () => {
  const { root, read } = fixture(); const original = 'a😀é中z😀tail'; writeFileSync(join(root, 'input.ts'), original);
  let offset = 0, recovered = '';
  do {
    const page = JSON.parse(text(await read({ byte_offset: offset, max_bytes: 5 })));
    expect(page.byte_offset).toBe(offset); expect(page.content).not.toContain('�'); recovered += page.content;
    offset = page.next_byte_offset;
  } while (offset != null);
  expect(recovered).toBe(original);
  const inside = JSON.parse(text(await read({ byte_offset: 3, max_bytes: 4 })));
  expect(inside.byte_offset).toBe(1); expect(inside.content).toBe('😀');
  const bytes = Buffer.from([0, 255, 254, 1, 9, 10]); writeFileSync(join(root, 'input.ts'), bytes);
  const first = JSON.parse(text(await read({ byte_offset: 0, max_bytes: 4, encoding: 'base64' })));
  const last = JSON.parse(text(await read({ byte_offset: 4, max_bytes: 4, encoding: 'base64' })));
  expect(Buffer.concat([Buffer.from(first.content, 'base64'), Buffer.from(last.content, 'base64')])).toEqual(bytes);
});

it('rejects oversized full reads but permits a bounded page at the end of a large file', async () => {
  const { root, read } = fixture(), file = join(root, 'input.ts');
  const fd = openSync(file, 'w'); ftruncateSync(fd, 17 * 1024 * 1024); closeSync(fd);
  await expect(read({ force: true })).rejects.toThrow('byte_offset');
  const result = JSON.parse(text(await read({ byte_offset: 17 * 1024 * 1024 - 4, max_bytes: 4, encoding: 'base64' })));
  expect(result.retained_bytes).toBe(4); expect(result.next_byte_offset).toBeUndefined();
});

it('interrupts pathological regex backtracking and treats patterns only as data', () => {
  const started = performance.now();
  expect(() => scanPattern('(a+)+$', ['a'.repeat(10000) + '!'], 'first')).toThrow('exceeded 50 ms');
  expect(performance.now() - started).toBeLessThan(1000);
  expect(scanPattern('foo|bar', ['none', 'BAR'], 'first')).toBe(1);
  expect(scanPattern('^f', ['foo', 'bar', 'far'], 'filter')).toEqual([0, 2]);
  expect(() => scanPattern('[', ['anything'], 'first')).toThrow('Invalid pattern');
});

it('rejects cancellation and paths escaping through traversal or junctions', async () => {
  const { root, ctx, read } = fixture(); mkdirSync(join(root, 'project')); mkdirSync(join(root, 'outside'));
  writeFileSync(join(root, 'outside', 'input.ts'), 'private'); symlinkSync(join(root, 'outside'), join(root, 'project', 'outside'), 'junction');
  await expect(readProjectFile(join(root, 'project'), 'outside/input.ts')).rejects.toThrow('outside');
  await expect(read({ file_path: '../private' })).rejects.toThrow('outside');
  await expect(readFile.handler({ project_name: 'read-test', file_path: 'input.ts' },
    { ...ctx, signal: AbortSignal.abort(new Error('stopped')) })).rejects.toThrow('stopped');
});

it('checks selectors before reading and returns explicit symbol, range and regex errors', async () => {
  const { root, read } = fixture(); writeFileSync(join(root, 'input.ts'), 'export function value() { return 42; }\n');
  for (const args of [{ start_line: 0 }, { end_line: -1 }, { max_lines: 1.5 }, { around_line: 0 },
    { byte_offset: -1 }, { max_bytes: 3 }, { byte_offset: 0, symbol: 'value' }, { force: 'yes' }]) {
    await expect(read(args)).rejects.toThrow();
  }
  expect(text(await read({ symbol: 'value' }))).toContain('return 42');
  expect(text(await read({ around_line: 1 }))).toContain('symbol body');
  expect(text(await read({ search_term: 'value' }))).toContain('Auto-scrolled');
  await expect(read({ symbol: 'missing' })).rejects.toThrow('not found');
});

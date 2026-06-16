/**
 * Engine tests for Find/Replace in Files — exercise matching, positions, the
 * case/word/regex toggles, the glob mask, and replace-and-write against a real
 * temp directory (no DB / sqlite needed; the corpus is a fake file lister).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { grepProject } from '../text-grep.js';
import { replaceInProject } from '../text-replace.js';

function fakeDb(root: string, files: string[]) {
  return {
    getProject: () => ({ root_path: root }),
    listFiles: () => files.map((path) => ({ path })),
  };
}

let dir: string;
const A = 'const Service = 1;\nfunction getService() {}\n// service comment\n';
const B = 'export const x = "Service";\n';

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'mcp-grep-'));
  mkdirSync(join(dir, 'src'), { recursive: true });
  writeFileSync(join(dir, 'src', 'a.ts'), A);
  writeFileSync(join(dir, 'src', 'b.tsx'), B);
});
afterAll(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ } });

describe('grepProject', () => {
  it('literal, case-insensitive, with match positions', async () => {
    const r = await grepProject(fakeDb(dir, ['src/a.ts', 'src/b.tsx']), 1, { query: 'service' });
    expect(r.fileCount).toBe(2);
    expect(r.total).toBe(4); // a.ts: Service, getService, service (3) + b.tsx: Service (1)
    const a = r.files.find((f) => f.path === 'src/a.ts')!;
    const first = a.matches[0];
    expect(first.text.slice(first.start, first.end).toLowerCase()).toBe('service');
  });

  it('case-sensitive narrows to the exact casing', async () => {
    const r = await grepProject(fakeDb(dir, ['src/a.ts']), 1, { query: 'service', caseSensitive: true });
    expect(r.total).toBe(1); // only the lowercase 'service' in the comment
  });

  it('whole word excludes substrings (getService)', async () => {
    const r = await grepProject(fakeDb(dir, ['src/a.ts']), 1, { query: 'Service', wholeWord: true });
    expect(r.total).toBe(2); // 'Service' (l1) + 'service' (l3, ci); NOT getService
  });

  it('regex matches', async () => {
    const r = await grepProject(fakeDb(dir, ['src/a.ts']), 1, { query: 'get\\w+', regex: true });
    expect(r.total).toBe(1);
    expect(r.files[0].matches[0].text.slice(r.files[0].matches[0].start, r.files[0].matches[0].end)).toBe('getService');
  });

  it('mask filters by basename glob', async () => {
    const r = await grepProject(fakeDb(dir, ['src/a.ts', 'src/b.tsx']), 1, { query: 'Service', mask: '*.tsx' });
    expect(r.files.every((f) => f.path.endsWith('.tsx'))).toBe(true);
    expect(r.fileCount).toBe(1);
  });

  it('maxMatches truncates', async () => {
    const r = await grepProject(fakeDb(dir, ['src/a.ts']), 1, { query: 'service', maxMatches: 1 });
    expect(r.total).toBe(1);
    expect(r.truncated).toBe(true);
  });
});

describe('replaceInProject', () => {
  it('replaces and writes the file', async () => {
    const local = mkdtempSync(join(tmpdir(), 'mcp-rep-'));
    mkdirSync(join(local, 'src'), { recursive: true });
    writeFileSync(join(local, 'src', 'b.tsx'), B);
    try {
      const res = await replaceInProject(fakeDb(local, ['src/b.tsx']), undefined, 1, {
        query: 'Service', replacement: 'Product',
      });
      expect(res.replaced).toBe(1);
      expect(res.fileCount).toBe(1);
      expect(readFileSync(join(local, 'src', 'b.tsx'), 'utf8')).toContain('Product');
    } finally {
      rmSync(local, { recursive: true, force: true });
    }
  });

  it('regex replacement supports backrefs', async () => {
    const local = mkdtempSync(join(tmpdir(), 'mcp-rep2-'));
    mkdirSync(join(local, 'src'), { recursive: true });
    writeFileSync(join(local, 'src', 'c.ts'), 'foo_bar baz_qux\n');
    try {
      const res = await replaceInProject(fakeDb(local, ['src/c.ts']), undefined, 1, {
        query: '(\\w+)_(\\w+)', replacement: '$2_$1', regex: true,
      });
      expect(res.replaced).toBe(2);
      expect(readFileSync(join(local, 'src', 'c.ts'), 'utf8')).toBe('bar_foo qux_baz\n');
    } finally {
      rmSync(local, { recursive: true, force: true });
    }
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { Database, type DB } from '@mcp/store/db/types.js';
import type { CodeIndexDB } from '@mcp/store/db.js';
import type { ExportOptions } from '@mcp/shared/types.js';
import { ExportService } from '../exporter.js';
import { exportOutputPath, publishExport } from '../export-publish.js';
import { EXPORT_MAX_BYTES } from '../export-source.js';

vi.mock('node:fs/promises', async importOriginal => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return { ...actual, rename: vi.fn(actual.rename), open: vi.fn(actual.open) };
});
let root: string; let sql: DB; let db: CodeIndexDB; let options: ExportOptions;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'harness-export-'));
  sql = new Database(join(root, 'index.sqlite'));
  sql.exec(`CREATE TABLE files (id INTEGER PRIMARY KEY, project_id INTEGER, path TEXT, language TEXT, line_count INTEGER, size INTEGER, content_hash TEXT);
    CREATE UNIQUE INDEX files_path ON files(project_id, path);
    CREATE TABLE symbols (id INTEGER PRIMARY KEY, project_id INTEGER, name TEXT, kind TEXT, signature TEXT, file_path TEXT, line INTEGER, tags TEXT);
    CREATE INDEX symbols_name ON symbols(project_id, name);
    CREATE TABLE snapshots (id INTEGER PRIMARY KEY, project_id INTEGER, title TEXT, category TEXT, content TEXT, archived_at TEXT);
    CREATE INDEX snapshots_project ON snapshots(project_id);`);
  db = { projectScopedDb: () => sql, raw: () => sql,
    getProject: () => ({ id: 1, name: 'Fixture', description: 'Export fixture' }),
    getStats: vi.fn(() => ({ file_count: 0, symbol_count: 0, total_lines: 0, languages: {} })),
    listFiles: vi.fn(() => { throw new Error('unbounded file read'); }),
    listAllSymbols: vi.fn(() => { throw new Error('unbounded symbol read'); }),
  } as unknown as CodeIndexDB;
  options = { projectId: 1, projectName: 'Fixture', sections: [], format: 'markdown', outputPath: join(root, 'export.md'), includeSnapshots: true, includeCosts: false };
});
afterEach(() => {
  vi.clearAllMocks(); sql.close(); rmSync(root, { recursive: true, force: true });
});
function seed(count: number) {
  const file = sql.prepare('INSERT INTO files VALUES(?,1,?,\'ts\',1,100,\'hash\')');
  const symbol = sql.prepare('INSERT INTO symbols VALUES(?,1,?,\'function\',?, ?,1,\'[]\')');
  sql.transaction(() => { for (let i = 1; i <= count; i++) {
    const path = `src/${String(i).padStart(5, '0')}.ts`;
    file.run(i, path); symbol.run(i, 'repeatedName', `signature-${i}`.padEnd(140, 'x'), path);
  } })();
}

describe('bounded documentation export', () => {
  it('exports all symbols past page boundaries and the old 100-row cut, preserving full signatures', async () => {
    seed(601);
    const result = await new ExportService(db).export({ ...options, sections: ['files', 'symbols'] });
    expect(result.match(/\| repeatedName \|/g)).toHaveLength(601);
    expect(result).toContain('signature-601'.padEnd(140, 'x'));
    expect(readFileSync(options.outputPath!, 'utf8')).toBe(result);
    expect(db.listFiles).not.toHaveBeenCalled(); expect(db.listAllSymbols).not.toHaveBeenCalled();
  });
  it('JSON honors sections without computing discarded markdown, stats, files or symbols', async () => {
    seed(1);
    sql.prepare('INSERT INTO snapshots VALUES(1,1,\'Decision\',\'decision\',\'keep this\',NULL)').run();
    sql.prepare('INSERT INTO snapshots VALUES(2,1,\'Archived\',\'note\',\'omit this\',\'today\')').run();
    const result = JSON.parse(await new ExportService(db).export({ ...options, format: 'json', sections: ['snapshots'] }));
    expect(result.snapshots).toHaveLength(1); expect(result.snapshots[0].content).toBe('keep this');
    expect(result).not.toHaveProperty('symbols'); expect(result).not.toHaveProperty('files');
    expect(result).not.toHaveProperty('stats'); expect(db.getStats).not.toHaveBeenCalled();
  });
  it('escapes table cells and reports malformed API tags instead of crashing or silently ignoring them', async () => {
    seed(2);
    sql.prepare('UPDATE symbols SET tags=\'bad JSON\' WHERE id=1').run();
    sql.prepare('UPDATE symbols SET tags=\'["api"]\', signature=? WHERE id=2').run('a|b\n<script>`');
    const result = await new ExportService(db).export({ ...options, sections: ['api'] });
    expect(result).toContain('a&#124;b<br>&lt;script&gt;&#96;');
    expect(result).toContain('1 symbol(s) had invalid API tags');
  });
  it('gives the event loop time during a large export and cancels without replacing the previous file', async () => {
    seed(2000); writeFileSync(options.outputPath!, 'previous');
    const controller = new AbortController(); let ran = false;
    setImmediate(() => { ran = true; controller.abort(); });
    await expect(new ExportService(db).export({ ...options, sections: ['symbols'] }, controller.signal)).rejects.toThrow();
    expect(ran).toBe(true); expect(readFileSync(options.outputPath!, 'utf8')).toBe('previous');
    expect(readdirSync(root).filter(name => name.endsWith('.tmp'))).toEqual([]);
  });
  it('rejects a mixed revision when the shared connection changes between pages', async () => {
    seed(600); writeFileSync(options.outputPath!, 'previous');
    setImmediate(() => sql.prepare('UPDATE symbols SET signature=\'changed\' WHERE id=600').run());
    await expect(new ExportService(db).export({ ...options, sections: ['symbols'] })).rejects.toThrow('index changed');
    expect(readFileSync(options.outputPath!, 'utf8')).toBe('previous');
  });
  it('also detects a second SQLite connection committing during pagination', async () => {
    seed(600);
    const other = new Database(join(root, 'index.sqlite'));
    try {
      setImmediate(() => other.prepare('UPDATE symbols SET signature=\'external\' WHERE id=600').run());
      await expect(new ExportService(db).export({ ...options, sections: ['symbols'] })).rejects.toThrow('index changed');
    } finally { other.close(); }
  });
  it('rejects oversized output explicitly, preserving the existing document', async () => {
    seed(1); writeFileSync(options.outputPath!, 'previous');
    sql.prepare('UPDATE symbols SET signature=?').run('x'.repeat(EXPORT_MAX_BYTES + 1));
    await expect(new ExportService(db).export({ ...options, sections: ['symbols'] })).rejects.toThrow('exceeds 32 MiB');
    expect(readFileSync(options.outputPath!, 'utf8')).toBe('previous');
  });
  it('validates sections and format before reading or writing', async () => {
    await expect(new ExportService(db).export({ ...options, format: 'invalid' as 'json' })).rejects.toThrow('format');
    await expect(new ExportService(db).export({ ...options, sections: ['constructor' as 'files'] })).rejects.toThrow('sections');
    expect(db.getStats).not.toHaveBeenCalled();
  });
  it.each(['../escape', '..\\escape', 'CON', 'AUX.txt', 'trailing.', 'a:b', '/absolute'])('keeps unsafe project name %s inside the default export directory', name => {
    const normal = exportOutputPath({ ...options, outputPath: undefined });
    const path = exportOutputPath({ ...options, projectName: name, outputPath: undefined });
    expect(dirname(path)).toBe(dirname(normal)); expect(basename(path)).not.toBe(`${name}.md`);
  });
  it('writes one complete replacement and removes temporary files on rename failure', async () => {
    writeFileSync(options.outputPath!, 'previous');
    vi.mocked(fs.rename).mockRejectedValueOnce(Object.assign(new Error('disk error'), { code: 'EIO' }));
    await expect(publishExport(options.outputPath!, 'new')).rejects.toThrow('disk error');
    expect(readFileSync(options.outputPath!, 'utf8')).toBe('previous');
    expect(readdirSync(root).filter(name => name.endsWith('.tmp'))).toEqual([]);
    await publishExport(options.outputPath!, 'committed');
    expect(readFileSync(options.outputPath!, 'utf8')).toBe('committed');
  });
  it('checks cancellation immediately before rename and lets a successful commit win a later abort', async () => {
    writeFileSync(options.outputPath!, 'previous');
    const controller = new AbortController();
    const actualOpen = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(fs.open).mockImplementationOnce(async (...args: Parameters<typeof fs.open>) => {
      const handle = await actualOpen.open(...args); const sync = handle.sync.bind(handle);
      handle.sync = async () => { await sync(); controller.abort(); }; return handle;
    });
    await expect(publishExport(options.outputPath!, 'cancelled', controller.signal)).rejects.toThrow();
    expect(readFileSync(options.outputPath!, 'utf8')).toBe('previous');
    const later = new AbortController();
    vi.mocked(fs.rename).mockImplementationOnce(async (...args) => { await actualOpen.rename(...args); later.abort(); });
    await publishExport(options.outputPath!, 'committed', later.signal);
    expect(readFileSync(options.outputPath!, 'utf8')).toBe('committed');
  });
});

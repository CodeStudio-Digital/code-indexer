import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { FileScanner } from '@mcp/indexer/indexer/scanner.js';
import { CodeIndexDB } from '@mcp/store/db.js';

describe('FileScanner', () => {
  let root: string;
  let dbPath: string;
  let db: CodeIndexDB;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mcp-scanner-'));
    dbPath = join(root, '.db');
    db = new CodeIndexDB(dbPath);
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  describe('hashContent', () => {
    it('is deterministic and changes on modification', () => {
      const a = FileScanner.hashContent('hello world');
      const b = FileScanner.hashContent('hello world');
      const c = FileScanner.hashContent('hello WORLD');
      expect(a).toBe(b);
      expect(a).not.toBe(c);
      // sha256 hex length
      expect(a).toHaveLength(64);
    });
  });

  describe('countLines', () => {
    it('counts lines correctly', () => {
      expect(FileScanner.countLines('one')).toBe(1);
      expect(FileScanner.countLines('one\ntwo')).toBe(2);
      expect(FileScanner.countLines('one\ntwo\nthree\n')).toBe(4);
    });
  });

  describe('scan', () => {
    it('picks up new files on the first scan', async () => {
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
      writeFileSync(join(root, 'src', 'b.ts'), 'export const b = 2;\n');
      const project = db.createProject('p', root);
      const scanner = new FileScanner(root);
      const result = await scanner.scan(db, project.id);
      expect(result.toIndex.length).toBe(2);
      expect(result.unchanged.length).toBe(0);
    });

    it('marks unchanged files as unchanged on second scan', async () => {
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, 'src', 'a.ts'), 'export const a = 1;\n');
      const project = db.createProject('p', root);
      const scanner = new FileScanner(root);
      const first = await scanner.scan(db, project.id);

      // Simulate previously-indexed file
      const sf = first.toIndex[0];
      db.upsertFile(project.id, {
        path: sf.relativePath,
        language: 'typescript',
        size: sf.sizeBytes,
        lineCount: sf.lineCount,
        contentHash: sf.hash,
        dependencies: [],
        internalDeps: [],
        externalDeps: [],
      });

      const second = await scanner.scan(db, project.id);
      expect(second.toIndex.length).toBe(0);
      expect(second.unchanged.length).toBe(1);
    });

    it('detects modified files via hash change', async () => {
      mkdirSync(join(root, 'src'), { recursive: true });
      const fp = join(root, 'src', 'a.ts');
      writeFileSync(fp, 'export const a = 1;\n');
      const project = db.createProject('p', root);
      const scanner = new FileScanner(root);
      const first = await scanner.scan(db, project.id);
      const sf = first.toIndex[0];
      db.upsertFile(project.id, {
        path: sf.relativePath,
        language: 'typescript',
        size: sf.sizeBytes,
        lineCount: sf.lineCount,
        contentHash: sf.hash,
        dependencies: [],
        internalDeps: [],
        externalDeps: [],
      });

      // Modify file
      writeFileSync(fp, 'export const a = 42;\n');
      const second = await scanner.scan(db, project.id);
      expect(second.toIndex.length).toBe(1);
      expect(second.unchanged.length).toBe(0);
    });

    it('respects ignore patterns', async () => {
      mkdirSync(join(root, 'src'), { recursive: true });
      mkdirSync(join(root, 'vendor'), { recursive: true });
      writeFileSync(join(root, 'src', 'a.ts'), 'a');
      writeFileSync(join(root, 'vendor', 'b.ts'), 'b');
      const project = db.createProject('p', root);
      const scanner = new FileScanner(root, ['vendor']);
      const result = await scanner.scan(db, project.id);
      const paths = result.toIndex.map((f) => f.relativePath);
      expect(paths).toContain('src/a.ts');
      expect(paths.some((p) => p.startsWith('vendor'))).toBe(false);
    });
  });
});

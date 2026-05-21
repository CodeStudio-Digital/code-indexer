import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodeIndexDB } from '@mcp/store/db.js';
import { computeStableId } from '@mcp/store/migrations/002_symbol_stable_id.js';
import type { LLMSymbol } from '@mcp/shared/types.js';

function mkSym(overrides: Partial<LLMSymbol> = {}): LLMSymbol {
  return {
    name: 'foo',
    kind: 'function',
    signature: 'foo()',
    parent: null,
    modifiers: [],
    return_type: null,
    parameters: null,
    line: 1,
    comment: null,
    tags: [],
    ...overrides,
  } as LLMSymbol;
}

function mkFile(path: string, hash = 'h'): Parameters<CodeIndexDB['upsertFile']>[1] {
  return {
    path,
    language: 'typescript',
    size: 10,
    lineCount: 5,
    contentHash: hash,
    summary: '',
    concepts: [],
    dependencies: [],
    internalDeps: [],
    externalDeps: [],
    notes: [],
    complexity: 'low',
  };
}

describe('CodeIndexDB', () => {
  let dir: string;
  let dbPath: string;
  let db: CodeIndexDB;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-idx-test-'));
    dbPath = join(dir, 'test.db');
    db = new CodeIndexDB(dbPath);
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  describe('migrations', () => {
    it('applies all migrations on a fresh DB', () => {
      expect(db.getSchemaVersion()).toBe(92);
    });

    it('re-opening an existing DB does not re-apply migrations', () => {
      db.close();
      const db2 = new CodeIndexDB(dbPath);
      expect(db2.getSchemaVersion()).toBe(92);
      db2.close();
    });

    it('coder_messages has is_meta column from migration 075 (PR-4)', () => {
      // @ts-expect-error - accessing internal for test
      const cols = db.db.prepare("PRAGMA table_info(coder_messages)").all() as {
        name: string;
      }[];
      const names = cols.map((c) => c.name);
      expect(names).toContain('is_meta');
    });

    it('coder_sessions has goal_* columns from migration 068', () => {
      // @ts-expect-error - accessing internal for test
      const cols = db.db.prepare("PRAGMA table_info(coder_sessions)").all() as {
        name: string;
      }[];
      const names = new Set(cols.map((c) => c.name));
      expect(names.has('goal_text')).toBe(true);
      expect(names.has('goal_status')).toBe(true);
      expect(names.has('goal_budget_tokens')).toBe(true);
      expect(names.has('goal_completion_note')).toBe(true);
      expect(names.has('goal_created_at')).toBe(true);
      expect(names.has('goal_updated_at')).toBe(true);
    });

    it('symbols.stable_id column exists', () => {
      // @ts-expect-error - accessing internal for test
      const cols = db.db.prepare("PRAGMA table_info(symbols)").all() as {
        name: string;
      }[];
      expect(cols.some((c) => c.name === 'stable_id')).toBe(true);
    });

    it('snapshot_files table is created by migration 003', () => {
      // @ts-expect-error - accessing internal for test
      const info = db.db.prepare("PRAGMA table_info(snapshot_files)").all();
      expect((info as unknown[]).length).toBeGreaterThan(0);
    });

    it('migration 067 drops `front_id` columns and `company_fronts` table', () => {
      // @ts-expect-error - accessing internal for test
      const inner = db.db as InstanceType<typeof import('better-sqlite3')>;
      const tables = inner
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all() as Array<{ name: string }>;
      const tableNames = new Set(tables.map((t) => t.name));
      expect(tableNames.has('company_fronts')).toBe(false);

      for (const table of ['company_agent_runs', 'company_board', 'company_master_prompts', 'agent_inbox']) {
        const cols = inner.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
        expect(cols.some((c) => c.name === 'front_id')).toBe(false);
      }

      const sessionCols = inner.prepare(`PRAGMA table_info(company_sessions)`).all() as Array<{ name: string }>;
      expect(sessionCols.some((c) => c.name === 'parent_session_id')).toBe(true);
    });
  });

  describe('stable_id', () => {
    it('is deterministic for same inputs', () => {
      const a = computeStableId({
        projectId: 1,
        filePath: 'src/a.ts',
        kind: 'function',
        parent: null,
        name: 'foo',
        signature: 'foo()',
      });
      const b = computeStableId({
        projectId: 1,
        filePath: 'src/a.ts',
        kind: 'function',
        parent: null,
        name: 'foo',
        signature: 'foo()',
      });
      expect(a).toBe(b);
    });

    it('differs across files', () => {
      const a = computeStableId({
        projectId: 1,
        filePath: 'src/a.ts',
        kind: 'function',
        parent: null,
        name: 'foo',
        signature: 'foo()',
      });
      const b = computeStableId({
        projectId: 1,
        filePath: 'src/b.ts',
        kind: 'function',
        parent: null,
        name: 'foo',
        signature: 'foo()',
      });
      expect(a).not.toBe(b);
    });
  });

  describe('symbol upsert + lookup', () => {
    it('persists stable_id on insert and can be found by it', () => {
      const project = db.createProject('testproj', dir);
      const fileId = db.upsertFile(project.id, mkFile('a.ts'));
      db.upsertSymbols(project.id, fileId, 'a.ts', [
        mkSym({ name: 'alpha', kind: 'function', signature: 'alpha()' }),
        mkSym({ name: 'beta', kind: 'class', signature: 'class beta' }),
      ]);

      const syms = db.getSymbolsByFile(project.id, 'a.ts');
      expect(syms).toHaveLength(2);
      for (const s of syms) {
        expect(s.stable_id).toBeTruthy();
      }

      const alpha = syms.find((s) => s.name === 'alpha')!;
      const found = db.findSymbolByStableId(project.id, alpha.stable_id!);
      expect(found?.id).toBe(alpha.id);
    });

    it('findSymbolsByName returns multiple matches for ambiguous names', () => {
      const project = db.createProject('p', dir);
      const faId = db.upsertFile(project.id, mkFile('a.ts'));
      const fbId = db.upsertFile(project.id, mkFile('b.ts'));

      db.upsertSymbols(project.id, faId, 'a.ts', [
        mkSym({ name: 'init', signature: 'init()' }),
      ]);
      db.upsertSymbols(project.id, fbId, 'b.ts', [
        mkSym({ name: 'init', signature: 'init()' }),
      ]);

      const matches = db.findSymbolsByName(project.id, 'init');
      expect(matches).toHaveLength(2);
      expect(new Set(matches.map((m) => m.file_path))).toEqual(
        new Set(['a.ts', 'b.ts'])
      );

      const onlyA = db.findSymbolsByName(project.id, 'init', {
        filePath: 'a.ts',
      });
      expect(onlyA).toHaveLength(1);
      expect(onlyA[0].file_path).toBe('a.ts');
    });

    it('findSymbolByName scoped by file returns the correct symbol', () => {
      const project = db.createProject('p', dir);
      const faId = db.upsertFile(project.id, mkFile('a.ts'));
      const fbId = db.upsertFile(project.id, mkFile('b.ts'));
      db.upsertSymbols(project.id, faId, 'a.ts', [
        mkSym({ name: 'init', signature: 'initA()' }),
      ]);
      db.upsertSymbols(project.id, fbId, 'b.ts', [
        mkSym({ name: 'init', signature: 'initB()' }),
      ]);
      const a = db.findSymbolByName(project.id, 'init', { filePath: 'a.ts' });
      const b = db.findSymbolByName(project.id, 'init', { filePath: 'b.ts' });
      expect(a?.signature).toBe('initA()');
      expect(b?.signature).toBe('initB()');
    });
  });

  describe('symbol re-upsert on same file', () => {
    it('replaces old symbols when file is re-indexed', () => {
      const project = db.createProject('p', dir);
      const fileId = db.upsertFile(project.id, mkFile('a.ts'));
      db.upsertSymbols(project.id, fileId, 'a.ts', [mkSym({ name: 'first' })]);
      db.upsertSymbols(project.id, fileId, 'a.ts', [mkSym({ name: 'second' })]);
      const names = db.getSymbolsByFile(project.id, 'a.ts').map((s) => s.name);
      expect(names).toEqual(['second']);
    });
  });
});

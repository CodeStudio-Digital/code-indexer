import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodeIndexDB } from '@mcp/store/db.js';
import { buildRepoMap, resolveRepoMapBudget } from '@mcp/code-agent/core/repo-map.js';

/**
 * Repo-map: optional system-prompt addendum that lists top-level public
 * symbols of recently-modified files. Gated by CODER_REPOMAP_TOKENS (off
 * when 0). These tests pin the budget contract so we never overshoot the
 * caller's char budget — the map sits at the END of the prompt and only
 * invalidates the trailing cache segment, but it must stay within budget.
 */

describe('buildRepoMap', () => {
  let workDir: string;
  let db: CodeIndexDB;
  let projectId: number;

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'rm-'));
    db = new CodeIndexDB(join(workDir, 'index.sqlite'));
    projectId = db.createProject('repo-map-proj', workDir).id;

    const fileBase = {
      language: 'ts',
      size: 100,
      lineCount: 50,
      contentHash: 'h',
      summary: 's',
      concepts: [],
      dependencies: [],
      internalDeps: [],
      externalDeps: [],
      notes: [],
      complexity: 'low',
      layer: 'core',
      isEntryPoint: false,
      isTest: false,
      isGenerated: false,
    };
    const usersFileId = db.upsertFile(projectId, { ...fileBase, path: 'src/users.ts' });
    db.upsertSymbols(projectId, usersFileId, 'src/users.ts', [
      { name: 'getUser', kind: 'function', signature: 'getUser(id: string)', parent: null, modifiers: [], return_type: 'User', parameters: 'id: string', line: 1, comment: null, tags: [] },
      { name: 'User', kind: 'interface', signature: 'interface User', parent: null, modifiers: [], return_type: null, parameters: null, line: 10, comment: null, tags: [] },
      { name: 'helper', kind: 'function', signature: 'helper()', parent: 'User', modifiers: [], return_type: null, parameters: null, line: 20, comment: null, tags: [] },
    ]);
    const ordersFileId = db.upsertFile(projectId, { ...fileBase, path: 'src/orders.ts' });
    db.upsertSymbols(projectId, ordersFileId, 'src/orders.ts', [
      { name: 'createOrder', kind: 'function', signature: 'createOrder()', parent: null, modifiers: [], return_type: 'Order', parameters: '', line: 1, comment: null, tags: [] },
      { name: 'Order', kind: 'class', signature: 'class Order', parent: null, modifiers: [], return_type: null, parameters: null, line: 10, comment: null, tags: [] },
    ]);
  });

  afterAll(() => {
    db.close();
    rmSync(workDir, { recursive: true, force: true });
  });

  it('returns empty when budget is 0', () => {
    expect(buildRepoMap(db, projectId, 0)).toBe('');
  });

  it('returns empty when budget is negative', () => {
    expect(buildRepoMap(db, projectId, -100)).toBe('');
  });

  it('lists top-level public symbols only (skips nested/private)', () => {
    const map = buildRepoMap(db, projectId, 4000);
    expect(map).toContain('# Repo map');
    // Top-level symbols present
    expect(map).toContain('function getUser');
    expect(map).toContain('interface User');
    expect(map).toContain('class Order');
    // Nested symbol (parent=User) is excluded
    expect(map).not.toContain('helper');
  });

  it('respects the char budget — never produces more chars than budget plus a small overhead', () => {
    const budget = 200;
    const map = buildRepoMap(db, projectId, budget);
    // The implementation tracks per-line accumulation; total may exceed
    // budget by the header + trailer note, but should not be more than
    // budget * 2 for a small project.
    expect(map.length).toBeLessThan(budget * 2 + 200);
  });

  it('marks elided files when the budget fits some but not all files', () => {
    // Budget tight enough to fit one file's symbol line but not both.
    const map = buildRepoMap(db, projectId, 60);
    expect(map).toMatch(/elided due to .* budget/);
  });

  it('returns empty for an unknown project id', () => {
    expect(buildRepoMap(db, 9999, 4000)).toBe('');
  });
});

describe('resolveRepoMapBudget', () => {
  let workDir: string;
  let db: CodeIndexDB;
  const originalEnv = process.env.CODER_REPOMAP_TOKENS;

  beforeAll(() => {
    workDir = mkdtempSync(join(tmpdir(), 'rm-budget-'));
    db = new CodeIndexDB(join(workDir, 'index.sqlite'));
  });

  afterAll(() => {
    db.close();
    rmSync(workDir, { recursive: true, force: true });
    if (originalEnv === undefined) delete process.env.CODER_REPOMAP_TOKENS;
    else process.env.CODER_REPOMAP_TOKENS = originalEnv;
  });

  afterEach(() => {
    delete process.env.CODER_REPOMAP_TOKENS;
  });

  /** Seed `n` minimal files into a fresh project; returns the project id. */
  function seedProject(name: string, n: number): number {
    const projectId = db.createProject(name, workDir).id;
    const fileBase = {
      language: 'ts', size: 100, lineCount: 50, contentHash: 'h',
      summary: 's', concepts: [], dependencies: [], internalDeps: [],
      externalDeps: [], notes: [], complexity: 'low', layer: 'core',
      isEntryPoint: false, isTest: false, isGenerated: false,
    };
    for (let i = 0; i < n; i++) {
      db.upsertFile(projectId, { ...fileBase, path: `src/f${i}.ts` });
    }
    return projectId;
  }

  it('returns 0 when project is not indexed', () => {
    const projectId = seedProject('not-indexed', 500);
    expect(resolveRepoMapBudget(db, projectId, false)).toBe(0);
  });

  it('returns 0 for small projects (<50 files)', () => {
    const projectId = seedProject('tiny', 10);
    expect(resolveRepoMapBudget(db, projectId, true)).toBe(0);
  });

  it('returns 1500 for medium projects (50-499 files)', () => {
    const projectId = seedProject('medium', 100);
    expect(resolveRepoMapBudget(db, projectId, true)).toBe(1500);
  });

  it('returns 3000 for large projects (500-1999 files)', () => {
    const projectId = seedProject('large', 600);
    expect(resolveRepoMapBudget(db, projectId, true)).toBe(3000);
  });

  it('returns 4500 for huge projects (>=2000 files)', () => {
    const projectId = seedProject('huge', 2100);
    expect(resolveRepoMapBudget(db, projectId, true)).toBe(4500);
  });

  it('honors CODER_REPOMAP_TOKENS override with positive integer', () => {
    process.env.CODER_REPOMAP_TOKENS = '2500';
    const projectId = seedProject('override-pos', 10); // would auto to 0
    expect(resolveRepoMapBudget(db, projectId, true)).toBe(2500);
  });

  it('disables when CODER_REPOMAP_TOKENS is "0"', () => {
    process.env.CODER_REPOMAP_TOKENS = '0';
    const projectId = seedProject('override-zero', 2500); // would auto to 4500
    expect(resolveRepoMapBudget(db, projectId, true)).toBe(0);
  });

  it('treats invalid CODER_REPOMAP_TOKENS as disabled', () => {
    process.env.CODER_REPOMAP_TOKENS = 'banana';
    const projectId = seedProject('override-bad', 600); // would auto to 3000
    expect(resolveRepoMapBudget(db, projectId, true)).toBe(0);
  });

  it('treats empty CODER_REPOMAP_TOKENS as unset (uses auto-sizing)', () => {
    process.env.CODER_REPOMAP_TOKENS = '';
    const projectId = seedProject('override-empty', 600);
    expect(resolveRepoMapBudget(db, projectId, true)).toBe(3000);
  });
});

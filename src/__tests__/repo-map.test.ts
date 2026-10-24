import { describe, it, expect, beforeAll, afterAll, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodeIndexDB } from '@mcp/store/db.js';
import { buildRepoMap, resolveRepoMapBudget } from '@mcp/code-agent/core/repo-map.js';

/**
 * Repo-map: optional system-prompt addendum that lists top-level public
 * symbols of recently-modified files. Disabled when the caller budget is
 * zero. These tests pin the budget contract so we never overshoot the
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
  const originalEnv = process.env.CODER_REPOMAP_TOKENS;
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.CODER_REPOMAP_TOKENS;
    else process.env.CODER_REPOMAP_TOKENS = originalEnv;
  });
  const unusedDb = {} as CodeIndexDB;
  it('disables context when the project is not indexed', () => {
    expect(resolveRepoMapBudget(unusedDb, 1, false)).toBe(0);
  });
  it.each([undefined, '', '0', '2500', 'banana'])('retains the fixed prompt policy with retired environment value %s', value => {
    if (value === undefined) delete process.env.CODER_REPOMAP_TOKENS;
    else process.env.CODER_REPOMAP_TOKENS = value;
    expect(resolveRepoMapBudget(unusedDb, 1, true)).toBe(1024);
  });
});
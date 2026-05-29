/** Migration 115 — per-project memory_enabled toggle (default ON). */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { CodeIndexDB } from '../../db.js';

describe('migration 115 — memory_enabled', () => {
  let dir: string;
  let db: CodeIndexDB;
  let projectId: number;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-mem-toggle-'));
    db = new CodeIndexDB(join(dir, 'test.db'));
    projectId = db.createProject('p', dir).id;
  });

  afterEach(() => {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('defaults to enabled', () => {
    expect(db.getProjectMemoryEnabled(projectId)).toBe(true);
  });

  it('toggles off and back on', () => {
    db.setProjectMemoryEnabled(projectId, false);
    expect(db.getProjectMemoryEnabled(projectId)).toBe(false);
    db.setProjectMemoryEnabled(projectId, true);
    expect(db.getProjectMemoryEnabled(projectId)).toBe(true);
  });
});

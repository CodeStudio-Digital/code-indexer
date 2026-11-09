import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexDB } from '../../db.js';

describe('memory references after project database split', () => {
  let dir: string;
  let db: CodeIndexDB;
  let projectId: number;
  beforeEach(() => {
    vi.stubEnv('MCP_PROJECT_DB', '1');
    vi.stubEnv('MCP_PROJECT_DB_SPLIT', '1');
    vi.stubEnv('MCP_PROJECT_DB_ROUTE', '1');
    vi.stubEnv('MCP_PROJECT_DB_NEW', '0');
    dir = mkdtempSync(join(tmpdir(), 'memory-routing-'));
    const root = join(dir, 'project'); mkdirSync(root);
    db = new CodeIndexDB(join(dir, 'catalog.db'));
    projectId = db.createProject('routing', root).id;
    db.upsertFileStructural(projectId, { path: 'a.ts', language: 'typescript', size: 1, lineCount: 1, contentHash: 'old', mtimeMs: 1 });
    expect(db.ensureProjectSplit(projectId)?.status).toBe('done');
  });
  afterEach(() => { db?.close(); vi.unstubAllEnvs(); if (dir) rmSync(dir, { recursive: true, force: true }); });

  it('captures and replaces with current hashes, but preserves old memories for staleness checks', () => {
    const old = db.createAgentMemory({ projectId, name: 'old', content: 'original', referencedFiles: ['a.ts'] });
    db.upsertFileStructural(projectId, { path: 'a.ts', language: 'typescript', size: 2, lineCount: 1, contentHash: 'new', mtimeMs: 2 });
    expect(db.getAgentMemoryStaleBatch([old.id]).get(old.id)).toEqual({ stale: ['a.ts'], total: 1 });
    const fresh = db.createAgentMemory({ projectId, name: 'new', content: 'updated', referencedFiles: ['a.ts'] });
    expect(JSON.parse(fresh.referenced_files!)).toEqual([{ path: 'a.ts', hash: 'new' }]);
    const replaced = db.replaceAgentMemory(old.id, { projectId, name: 'old', content: 'verified update', referencedFiles: ['a.ts'] });
    expect(JSON.parse(replaced.referenced_files!)).toEqual([{ path: 'a.ts', hash: 'new' }]);
    expect(db.raw().prepare('SELECT content_hash FROM files WHERE project_id=?').get(projectId)).toEqual({ content_hash: 'old' });
  });

  it('still checks local hashes after central file rows have been trimmed', () => {
    db.raw().prepare('DELETE FROM files WHERE project_id=?').run(projectId);
    const memory = db.createAgentMemory({ projectId, name: 'local', content: 'remember', referencedFiles: ['a.ts', 'unknown.ts'] });
    expect(JSON.parse(memory.referenced_files!)).toEqual([{ path: 'a.ts', hash: 'old' }, { path: 'unknown.ts', hash: null }]);
    db.upsertFileStructural(projectId, { path: 'a.ts', language: 'typescript', size: 2, lineCount: 1, contentHash: 'new', mtimeMs: 2 });
    expect(db.getAgentMemoryStaleBatch([memory.id]).get(memory.id)).toEqual({ stale: ['a.ts'], total: 1, unknown: 1 });
  });
});

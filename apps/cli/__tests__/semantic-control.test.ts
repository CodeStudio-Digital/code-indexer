import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { CodeIndexDB } from '@mcp/store/db.js';
import { SemanticStore } from '@mcp/store/semantic-store.js';
import { SnapshotService } from '@mcp/services/services/snapshots.js';
import { loadConfig } from '@mcp/shared/utils/config.js';
import {
  createCliSemanticMutationSink,
  queueSemanticReindex,
  requestProjectRemoval,
} from '../semantic-control.js';

const dirs: string[] = [];

function harness(): { dir: string; db: CodeIndexDB; projectId: number } {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-cli-semantic-'));
  dirs.push(dir);
  const db = new CodeIndexDB(join(dir, 'index.db'));
  const project = db.createProject('cli-project', join(dir, 'project'));
  return { dir, db, projectId: project.id };
}

function config() {
  return {
    ...loadConfig(),
    dashboard: { host: '0.0.0.0', port: 7333 },
  };
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('CLI semantic control', () => {
  it('persists targeted snapshot deltas without scheduling a purpose-wide reindex', async () => {
    const { db, projectId } = harness();
    const wake = vi.fn();
    try {
      const snapshots = new SnapshotService(db, null, null, createCliSemanticMutationSink(db, { wake }));
      const created = await snapshots.create(projectId, {
        title: 'Initial', category: 'decision', content: 'Use the local worker.',
      });
      await snapshots.update(created.snap.id, { title: 'Edited' });
      snapshots.delete(created.snap.id);

      const semantic = new SemanticStore(db.raw());
      const mutationJobs = semantic.listJobs({ namespace: `snapshot:p${projectId}` });
      expect(mutationJobs).toHaveLength(3);
      expect(mutationJobs).toEqual(expect.arrayContaining([
        expect.objectContaining({
          kind: 'delta', status: 'pending', expected_items: 1,
          cursor: expect.objectContaining({
            reason: 'mutation-fence', fence_phase: 'settled',
            operation: 'upsert', item_keys: ['*'],
          }),
        }),
        expect.objectContaining({
          kind: 'delta', status: 'pending', expected_items: 1,
          cursor: expect.objectContaining({
            reason: 'mutation-fence', fence_phase: 'settled',
            operation: 'delete', item_keys: [`snapshot:${created.snap.id}`],
          }),
        }),
      ]));
      expect(mutationJobs.every((job) =>
        Number(job.cursor?.fence_lease_expires_at_ms) > Number(job.cursor?.fence_started_at_ms)))
        .toBe(true);
      expect(semantic.listJobs().some((job) =>
        job.namespace === 'semantic:reindex:memory')).toBe(false);
      expect(wake).toHaveBeenCalledWith(`snapshot:p${projectId}`);
    } finally {
      db.close();
    }
  });

  it('keeps a purpose-wide reindex available only as an explicit command', async () => {
    const { db } = harness();
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ ok: true }), {
      status: 202,
      headers: { 'content-type': 'application/json' },
    }));
    try {
      const wake = await queueSemanticReindex(db, 'memory', {
        config: config(),
        fetchImpl: fetchImpl as typeof fetch,
      });
      expect(wake.server).toMatchObject({ reached: true, ok: true, status: 202 });
      expect(new SemanticStore(db.raw()).listJobs().some((job) =>
        job.namespace === 'semantic:reindex:memory'
        && job.kind === 'build'
        && job.status === 'pending')).toBe(true);
      expect(fetchImpl).toHaveBeenCalledWith(
        'http://127.0.0.1:7333/api/admin/semantic/profiles/memory/reindex',
        expect.objectContaining({ method: 'POST' }),
      );
    } finally {
      db.close();
    }
  });

  it('leaves the project, FTS and vectors.db intact when no owner server can drain removal', async () => {
    const { dir, db, projectId } = harness();
    const vectorPath = join(dir, 'project', '.mcp-indexer', 'vectors.db');
    mkdirSync(dirname(vectorPath), { recursive: true });
    writeFileSync(vectorPath, 'owned-by-server');
    try {
      const result = await requestProjectRemoval(db, projectId, {
        config: config(),
        fetchImpl: vi.fn(async () => { throw new Error('ECONNREFUSED'); }) as typeof fetch,
      });

      expect(result.completed).toBe(false);
      expect(result.server).toMatchObject({ reached: false, ok: false });
      expect(db.getProject(projectId)).not.toBeNull();
      expect(existsSync(vectorPath)).toBe(true);
      expect(readFileSync(vectorPath, 'utf8')).toBe('owned-by-server');
      expect(new SemanticStore(db.raw()).hasProjectRemovalRequest(projectId)).toBe(true);
      expect(result.marker).toMatchObject({
        namespace: `project-removal:p${projectId}`,
        status: 'pending',
        cursor: expect.objectContaining({ requested_by: 'cli', finalize_project: true }),
      });
    } finally {
      db.close();
    }
  });

  it('keeps snapshot backfill free of direct sqlite-vec/router ownership', () => {
    const source = readFileSync(join(process.cwd(), 'apps/cli/commands/snapshots.ts'), 'utf8');
    expect(source).not.toContain('LocalVectorRouter');
    expect(source).not.toContain('backfillSnapshotEmbeddings');
    expect(source).not.toContain("queueSemanticReindex(db, 'memory')");
    expect(source).toContain('snapshotNamespace(project.id)');
  });

  it('keeps destructive project and hygiene commands behind the server owner', () => {
    for (const relative of ['apps/cli/commands/projects.ts', 'apps/cli/commands/hygiene.ts']) {
      const source = readFileSync(join(process.cwd(), relative), 'utf8');
      expect(source).not.toContain('LocalVectorRouter');
      expect(source).not.toContain('.removeProject(');
      expect(source).not.toContain('.deleteByItemKeys(');
    }
  });
});

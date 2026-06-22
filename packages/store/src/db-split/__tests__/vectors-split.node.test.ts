/**
 * R2 — per-project vectors split end-to-end against a real vec0 store.
 *
 * Seeds a central vectors file with two projects' code+snapshot vectors plus a
 * doc namespace, runs splitProjectVectors, and asserts the project's vectors.db
 * holds exactly THIS project's vectors (code + snapshot), vid + embedding
 * preserved, others excluded, central untouched, and the run is idempotent.
 *
 * ABI: imports better-sqlite3 + sqlite-vec → needs `pnpm node:rebuild`.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openVecConn, type VecDB } from '../vectors-io.js';
import { splitProjectVectors } from '../vectors-split.js';

const dirs: string[] = [];
function freshDir(): string {
  const d = mkdtempSync(join(tmpdir(), 'mcp-vsplit-'));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) {
    try { rmSync(dirs.pop()!, { recursive: true, force: true }); } catch { /* ignore */ }
  }
});

const f32 = (a: number[]): Buffer => Buffer.from(new Float32Array(a).buffer);

async function seedCentral(path: string): Promise<void> {
  const db: VecDB = await openVecConn(path);
  db.exec(`CREATE VIRTUAL TABLE vectors USING vec0(
    vid TEXT PRIMARY KEY, embedding float[3], namespace TEXT, project_name TEXT, type TEXT, ref_id TEXT)`);
  const ins = db.prepare(
    `INSERT INTO vectors(vid, embedding, namespace, project_name, type, ref_id) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  ins.run('file::1', f32([1, 0, 0]), 'code:p1', 'p1', 'file', '1');
  ins.run('sym::2', f32([0, 1, 0]), 'code:p1', 'p1', 'symbol', '2');
  ins.run('snap::3', f32([0, 0, 1]), '', 'p1', 'snapshot', '3'); // snapshot: no namespace
  ins.run('file::9', f32([1, 1, 0]), 'code:p2', 'p2', 'file', '9'); // other project
  ins.run('doc::5', f32([1, 0, 1]), 'docs:c5', '', 'doc_chunk', '5'); // docs: no project_name
  db.close();
}

describe('splitProjectVectors (R2)', () => {
  it("moves a project's code+snapshot vectors, preserves vid, excludes others, keeps central", async () => {
    const dir = freshDir();
    const centralPath = join(dir, 'vectors-sqlite-vec.db');
    const projPath = join(dir, 'p1', '.mcp-indexer', 'vectors.db');
    await seedCentral(centralPath);

    const outcome = await splitProjectVectors({
      centralVectorsPath: centralPath, projectVectorsPath: projPath, projectName: 'p1', trackedVectorIds: 3,
    });
    expect(outcome.status, `vectors split: ${outcome.reason}`).toBe('done');
    expect(outcome.copied).toBe(2);

    const proj = await openVecConn(projPath, { readonly: true });
    try {
      const vids = (proj.prepare('SELECT vid FROM vectors ORDER BY vid').all() as { vid: string }[]).map((r) => r.vid);
      // p1 CODE only: snapshot (snap::3, namespace-less) stays central — the
      // routing facade never sends snapshot ops to a per-project store. p2 + doc excluded.
      expect(vids).toEqual(['file::1', 'sym::2']);
      // Embedding preserved → KNN finds the right vid.
      const top = (proj.prepare('SELECT vid FROM vectors WHERE embedding MATCH ? AND k = ? ORDER BY distance')
        .all(f32([1, 0, 0]), 3) as { vid: string }[])[0].vid;
      expect(top).toBe('file::1');
    } finally {
      proj.close();
    }

    // Central untouched (deferred purge).
    const central = await openVecConn(centralPath, { readonly: true });
    try {
      expect((central.prepare('SELECT COUNT(*) AS n FROM vectors').get() as { n: number }).n).toBe(5);
    } finally {
      central.close();
    }

    // Idempotent: a second run rebuilds the same project store.
    const again = await splitProjectVectors({
      centralVectorsPath: centralPath, projectVectorsPath: projPath, projectName: 'p1', trackedVectorIds: 3,
    });
    expect(again.status).toBe('done');
    expect(again.copied).toBe(2);
  });

  it('is a no-op (done) when the central vectors file is absent', async () => {
    const dir = freshDir();
    const outcome = await splitProjectVectors({
      centralVectorsPath: join(dir, 'nope.db'),
      projectVectorsPath: join(dir, 'p', '.mcp-indexer', 'vectors.db'),
      projectName: 'p', trackedVectorIds: 0,
    });
    expect(outcome.status).toBe('done');
    expect(existsSync(join(dir, 'p', '.mcp-indexer', 'vectors.db'))).toBe(false);
  });

  it('returns done with 0 copied when the project has no vectors', async () => {
    const dir = freshDir();
    const centralPath = join(dir, 'vectors-sqlite-vec.db');
    await seedCentral(centralPath);
    const outcome = await splitProjectVectors({
      centralVectorsPath: centralPath,
      projectVectorsPath: join(dir, 'ghost', '.mcp-indexer', 'vectors.db'),
      projectName: 'ghost-project', trackedVectorIds: 0,
    });
    expect(outcome.status).toBe('done');
    expect(outcome.copied).toBe(0);
  });
});

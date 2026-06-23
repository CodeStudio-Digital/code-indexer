/**
 * Tests for `project_doc_collections` (migration 134) — the N:M scoping
 * layer between projects and doc collections. Pins the invariants the
 * search backend relies on:
 *
 *   - link is idempotent (INSERT OR IGNORE) and the first origin wins
 *   - deleting a collection (or project) cascades the link rows
 *   - listCollectionsForProject returns full DocCollection rows
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CodeIndexDB } from '../../db.js';
import { DocStore } from '../../doc-store.js';

interface Handle {
  db: CodeIndexDB;
  store: DocStore;
  dir: string;
}

function setup(): Handle {
  const dir = mkdtempSync(join(tmpdir(), 'mcp-doc-links-test-'));
  const db = new CodeIndexDB(join(dir, 'test.db'));
  const store = new DocStore(db.raw());
  return { db, store, dir };
}

describe('DocStore project ↔ collection links', () => {
  let h: Handle;
  beforeEach(() => { h = setup(); });
  afterEach(() => {
    h.db.close();
    rmSync(h.dir, { recursive: true, force: true });
  });

  it('links and lists collections for a project', () => {
    const project = h.db.createProject('proj-a', 'D:/tmp/proj-a');
    const colA = h.store.createCollection({ name: 'react-docs', description: 'React 19' });
    const colB = h.store.createCollection({ name: 'unity-docs' });
    h.store.createCollection({ name: 'unrelated' });

    expect(h.store.linkProjectCollection(project.id, colA.id)).toBe(true);
    expect(h.store.linkProjectCollection(project.id, colB.id, 'auto')).toBe(true);

    const linked = h.store.listCollectionsForProject(project.id);
    expect(linked.map((c) => c.name)).toEqual(['react-docs', 'unity-docs']);
    expect(linked[0].description).toBe('React 19');
  });

  it('is idempotent and the first origin wins', () => {
    const project = h.db.createProject('proj-b', 'D:/tmp/proj-b');
    const col = h.store.createCollection({ name: 'col-b' });

    expect(h.store.linkProjectCollection(project.id, col.id, 'manual')).toBe(true);
    expect(h.store.linkProjectCollection(project.id, col.id, 'auto')).toBe(false);

    const projects = h.store.listProjectsForCollection(col.id);
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({
      project_id: project.id,
      project_name: 'proj-b',
      origin: 'manual',
    });
  });

  it('unlinks and reports whether a row was removed', () => {
    const project = h.db.createProject('proj-c', 'D:/tmp/proj-c');
    const col = h.store.createCollection({ name: 'col-c' });
    h.store.linkProjectCollection(project.id, col.id);

    expect(h.store.unlinkProjectCollection(project.id, col.id)).toBe(true);
    expect(h.store.unlinkProjectCollection(project.id, col.id)).toBe(false);
    expect(h.store.listCollectionsForProject(project.id)).toHaveLength(0);
  });

  it('cascades link rows when the collection is deleted', () => {
    const project = h.db.createProject('proj-d', 'D:/tmp/proj-d');
    const col = h.store.createCollection({ name: 'col-d' });
    h.store.linkProjectCollection(project.id, col.id);

    h.store.deleteCollection(col.id);
    expect(h.store.listCollectionsForProject(project.id)).toHaveLength(0);
  });

  it('returns empty lists for unknown ids', () => {
    expect(h.store.listCollectionsForProject(9999)).toEqual([]);
    expect(h.store.listProjectsForCollection(9999)).toEqual([]);
  });
});

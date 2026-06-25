import { tmpdir } from 'node:os';
import { describe, it, expect, vi } from 'vitest';
import type { Project } from '@mcp/shared/types.js';
import type { CodeIndexDB } from '@mcp/store/db.js';
import { CreateProjectService } from '../create.js';
import { ProjectError } from '../errors.js';

/**
 * Minimal in-memory stub of the `CodeIndexDB` surface `CreateProjectService`
 * touches — keeps these unit tests free of the native better-sqlite3 ABI.
 */
function makeDb(seed: Project[] = []) {
  const rows = new Map<number, Project>();
  let nextId = 1;
  for (const p of seed) rows.set(p.id, p);

  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  const db = {
    getProjectByPath: vi.fn((rootPath: string) =>
      [...rows.values()].find((p) => norm(p.root_path) === norm(rootPath)),
    ),
    getProjectByName: vi.fn((name: string) =>
      [...rows.values()].find((p) => p.name === name),
    ),
    createProject: vi.fn((name: string, rootPath: string, description?: string) => {
      const p = { id: nextId++, name, root_path: rootPath, description: description ?? null } as unknown as Project;
      rows.set(p.id, p);
      return p;
    }),
    setProjectLoose: vi.fn((id: number, loose: boolean) => {
      const p = rows.get(id);
      if (p) (p as { is_loose?: number }).is_loose = loose ? 1 : 0;
    }),
  };
  return { db: db as unknown as CodeIndexDB, raw: db, rows };
}

const DIR = tmpdir(); // a real, existing directory so statSync passes

describe('CreateProjectService — loose folders (mig 176)', () => {
  it('marks a freshly created project as loose', () => {
    const { db, raw } = makeDb();
    const created = new CreateProjectService(db).execute({ root_path: DIR, loose: true });
    expect(raw.createProject).toHaveBeenCalledOnce();
    expect(raw.setProjectLoose).toHaveBeenCalledWith(created.id, true);
  });

  it('is idempotent: re-picking the same path returns the existing row (no throw)', () => {
    const existing = { id: 7, name: 'tmp', root_path: DIR, is_loose: 1 } as unknown as Project;
    const { db, raw } = makeDb([existing]);
    const got = new CreateProjectService(db).execute({ root_path: DIR, loose: true });
    expect(got.id).toBe(7);
    expect(raw.createProject).not.toHaveBeenCalled();
  });

  it('disambiguates the derived name on collision instead of failing', () => {
    // A project already owns the name the derived path would produce.
    const parts = DIR.replace(/\\/g, '/').split('/').filter(Boolean);
    const derived = parts.slice(-2).join('/') || 'project';
    const clash = { id: 3, name: derived, root_path: '/somewhere/else', is_loose: 0 } as unknown as Project;
    const { db, raw } = makeDb([clash]);
    const created = new CreateProjectService(db).execute({ root_path: DIR, loose: true });
    expect(created.name).toBe(`${derived} (2)`);
    expect(raw.createProject).toHaveBeenCalledOnce();
  });

  it('a NON-loose create still rejects a duplicate path', () => {
    const existing = { id: 7, name: 'tmp', root_path: DIR } as unknown as Project;
    const { db } = makeDb([existing]);
    expect(() => new CreateProjectService(db).execute({ root_path: DIR })).toThrow(ProjectError);
  });
});

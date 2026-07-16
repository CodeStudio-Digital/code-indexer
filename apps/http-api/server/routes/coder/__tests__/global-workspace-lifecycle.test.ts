import { afterEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ServerDeps } from '../../../deps.js';
import { teardownGlobalWorkspaceIfOrphan } from '../global-workspace.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function fixture(removeProject = vi.fn(async (
  _projectId: number,
  options?: { finalize?: () => void | Promise<void> },
) => {
  await options?.finalize?.();
})) {
  const root = mkdtempSync(join(tmpdir(), 'mcp-global-lifecycle-'));
  roots.push(root);
  const deleteProject = vi.fn();
  const stopWatching = vi.fn(async () => undefined);
  const deps = {
    db: {
      getProject: () => ({ id: 77, is_synthetic: true, root_path: root }),
      deleteProject,
    },
    sessionStore: { countSessionsForProject: () => 0 },
    projectIndexService: { stopWatching },
    semanticCoordinator: { removeProject },
  } as unknown as ServerDeps;
  return { deps, root, deleteProject, stopWatching, removeProject };
}

describe('global workspace semantic lifecycle', () => {
  it('stops indexing and removes vectors before project metadata', async () => {
    const h = fixture();

    await teardownGlobalWorkspaceIfOrphan(h.deps, 77);

    expect(h.stopWatching).toHaveBeenCalledWith(77);
    expect(h.removeProject).toHaveBeenCalledWith(77, { finalize: expect.any(Function) });
    expect(h.deleteProject).toHaveBeenCalledWith(77);
    expect(h.deleteProject).toHaveBeenCalledTimes(1);
    expect(h.removeProject.mock.invocationCallOrder[0]).toBeLessThan(
      h.deleteProject.mock.invocationCallOrder[0],
    );
    expect(existsSync(h.root)).toBe(false);
  });

  it('keeps metadata and workspace when semantic cleanup fails', async () => {
    const h = fixture(vi.fn(async () => { throw new Error('vectors busy'); }));

    await expect(teardownGlobalWorkspaceIfOrphan(h.deps, 77)).rejects.toThrow('vectors busy');

    expect(h.deleteProject).not.toHaveBeenCalled();
    expect(existsSync(h.root)).toBe(true);
  });
});

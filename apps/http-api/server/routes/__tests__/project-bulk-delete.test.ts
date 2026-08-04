import { mkdtemp, mkdir, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BulkProjectDeleteError,
  executeBulkProjectDelete,
  type BulkDeleteProject,
} from '../project-bulk-delete.js';

const cleanupRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    cleanupRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function fixtureRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'mcp-project-bulk-delete-'));
  cleanupRoots.push(root);
  return root;
}

function deps(projects: BulkDeleteProject[], deleteCatalogProject = vi.fn(async () => undefined)) {
  return {
    getProject: (id: number) => projects.find((project) => project.id === id) ?? null,
    listProjects: () => projects,
    deleteCatalogProject,
  };
}

describe('project bulk deletion', () => {
  it('requires a separate explicit confirmation token for folder deletion', async () => {
    const root = await fixtureRoot();
    const project = { id: 1, name: 'project', root_path: root };
    const deleteCatalogProject = vi.fn(async () => undefined);

    await expect(executeBulkProjectDelete(
      { projectIds: [1], confirm: true, deleteFolders: true },
      deps([project], deleteCatalogProject),
    )).rejects.toThrow(/explicit folder confirmation/);
    expect(deleteCatalogProject).not.toHaveBeenCalled();
  });

  it('removes multiple catalog entries while keeping folders by default', async () => {
    const root = await fixtureRoot();
    const first = join(root, 'first');
    const second = join(root, 'second');
    await Promise.all([mkdir(first), mkdir(second)]);
    const projects = [
      { id: 1, name: 'first', root_path: first },
      { id: 2, name: 'second', root_path: second },
    ];
    const deleteCatalogProject = vi.fn(async () => undefined);

    const result = await executeBulkProjectDelete(
      { projectIds: [1, 2], confirm: true },
      deps(projects, deleteCatalogProject),
    );

    expect(result).toMatchObject({ ok: true, projects_deleted: 2, folders_deleted: 0 });
    await expect(stat(first)).resolves.toBeTruthy();
    await expect(stat(second)).resolves.toBeTruthy();
    expect(deleteCatalogProject).toHaveBeenCalledTimes(2);
  });

  it('deletes selected project folders only after catalog deletion succeeds', async () => {
    const root = await fixtureRoot();
    const first = join(root, 'first');
    const second = join(root, 'second');
    await Promise.all([mkdir(first), mkdir(second)]);
    const projects = [
      { id: 1, name: 'first', root_path: first },
      { id: 2, name: 'second', root_path: second },
    ];

    const result = await executeBulkProjectDelete(
      {
        projectIds: [1, 2],
        confirm: true,
        deleteFolders: true,
        folderConfirmation: 'DELETE_FOLDERS',
      },
      deps(projects),
    );

    expect(result).toMatchObject({ ok: true, projects_deleted: 2, folders_deleted: 2 });
    await expect(stat(first)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(second)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preflights every target and refuses the running workspace before mutation', async () => {
    const root = await fixtureRoot();
    const project = { id: 1, name: 'workspace', root_path: root };
    const deleteCatalogProject = vi.fn(async () => undefined);

    await expect(executeBulkProjectDelete(
      {
        projectIds: [1],
        confirm: true,
        deleteFolders: true,
        folderConfirmation: 'DELETE_FOLDERS',
      },
      { ...deps([project], deleteCatalogProject), cwd: join(root, 'apps', 'dashboard') },
    )).rejects.toBeInstanceOf(BulkProjectDeleteError);
    expect(deleteCatalogProject).not.toHaveBeenCalled();
    await expect(stat(root)).resolves.toBeTruthy();
  });

  it('refuses a selected parent that contains an unselected registered project', async () => {
    const root = await fixtureRoot();
    const child = join(root, 'child');
    await mkdir(child);
    const projects = [
      { id: 1, name: 'parent', root_path: root },
      { id: 2, name: 'child', root_path: child },
    ];
    const deleteCatalogProject = vi.fn(async () => undefined);

    await expect(executeBulkProjectDelete(
      {
        projectIds: [1],
        confirm: true,
        deleteFolders: true,
        folderConfirmation: 'DELETE_FOLDERS',
      },
      deps(projects, deleteCatalogProject),
    )).rejects.toThrow(/unselected project "child"/);
    expect(deleteCatalogProject).not.toHaveBeenCalled();
  });

  it('refuses paths inside protected operating-system trees', async () => {
    const root = await fixtureRoot();
    const protectedTree = join(root, 'system');
    const projectRoot = join(protectedTree, 'registered-project');
    await mkdir(projectRoot, { recursive: true });
    const project = { id: 1, name: 'unsafe', root_path: projectRoot };
    const deleteCatalogProject = vi.fn(async () => undefined);

    await expect(executeBulkProjectDelete(
      {
        projectIds: [1],
        confirm: true,
        deleteFolders: true,
        folderConfirmation: 'DELETE_FOLDERS',
      },
      {
        ...deps([project], deleteCatalogProject),
        protectedSystemPaths: [protectedTree],
      },
    )).rejects.toThrow(/protected system path/);
    expect(deleteCatalogProject).not.toHaveBeenCalled();
    await expect(stat(projectRoot)).resolves.toBeTruthy();
  });

  it('reports a folder failure without pretending the catalog entry survived', async () => {
    const root = await fixtureRoot();
    const project = { id: 1, name: 'project', root_path: root };
    const deleteCatalogProject = vi.fn(async () => undefined);

    const result = await executeBulkProjectDelete(
      {
        projectIds: [1],
        confirm: true,
        deleteFolders: true,
        folderConfirmation: 'DELETE_FOLDERS',
      },
      {
        ...deps([project], deleteCatalogProject),
        removeDirectory: async () => { throw new Error('locked'); },
      },
    );

    expect(result).toMatchObject({
      ok: false,
      projects_deleted: 1,
      folders_deleted: 0,
      results: [{ catalog_deleted: true, folder_status: 'failed' }],
    });
    await expect(stat(root)).resolves.toBeTruthy();
  });
});

import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { FsSessionStore } from '@mcp/session-storage/fs-store/index.js';
import { OperationalSessionFiles } from '../operational-session-files.js';
import { createCompanySessionRuntimeResolver } from '../company-session-runtime-resolver.js';

const roots: string[] = [];

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'company-worker-runtime-'));
  roots.push(root);
  const dataDir = join(root, 'data');
  const projectA = join(root, 'project-a');
  const projectB = join(root, 'project-b');
  await Promise.all([
    mkdir(dataDir, { recursive: true }),
    mkdir(projectA, { recursive: true }),
    mkdir(projectB, { recursive: true }),
  ]);
  const projects = new Map([
    [11, { id: 11, name: 'Backend', root_path: projectA, is_synthetic: 0 }],
    [12, { id: 12, name: 'Frontend', root_path: projectB, is_synthetic: 0 }],
  ]);
  const sessions = FsSessionStore.fromRoots({
    dataDir,
    projectRootResolver: {
      resolveProjectRoot: (projectId) => projects.get(projectId)?.root_path,
      listProjectRoots: () =>
        [...projects.values()].map((project) => ({
          project_id: project.id,
          root_path: project.root_path,
        })),
    },
    projectInfoResolver: (projectId) => projects.get(projectId)
      ? {
          project_id: projectId,
          name: projects.get(projectId)!.name,
          root_path: projects.get(projectId)!.root_path,
        }
      : null,
  });
  const company = new OperationalSessionFiles({
    repository: sessions.repository,
    catalog: sessions.catalog,
    locator: sessions.locator,
    projects: { getProject: (projectId) => projects.get(projectId) ?? null },
  });
  return { dataDir, projectA, projects, sessions, company };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('createCompanySessionRuntimeResolver', () => {
  it('resolves a multi-project company from its global bundle and primary project', async () => {
    const { dataDir, projectA, projects, sessions, company } = await harness();
    const created = await company.createCompanySession({
      name: 'Benchmark company',
      project_ids: [11, 12],
    });

    const resolve = createCompanySessionRuntimeResolver(
      sessions,
      (projectId) => projects.get(projectId) ?? null,
    );

    await expect(resolve(created.id)).resolves.toEqual({
      sessionId: created.id,
      bundlePath: join(dataDir, 'sessions', 'global', created.id),
      projectId: 11,
      projectRoot: projectA,
    });
    await sessions.close();
  });

  it('fails closed when the primary project disappeared from the catalog', async () => {
    const { projects, sessions, company } = await harness();
    const created = await company.createCompanySession({
      name: 'Orphaned company',
      project_ids: [11, 12],
    });
    projects.delete(11);

    const resolve = createCompanySessionRuntimeResolver(
      sessions,
      (projectId) => projects.get(projectId) ?? null,
    );

    await expect(resolve(created.id)).rejects.toThrow(
      'Primary project 11 is unavailable',
    );
    await sessions.close();
  });
});

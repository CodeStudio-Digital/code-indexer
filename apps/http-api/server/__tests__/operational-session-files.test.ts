import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FileSessionRepository,
  SessionCatalog,
  SessionLocator,
} from '@mcp/session-storage';
import { OperationalSessionFiles } from '../operational-session-files.js';

const roots: string[] = [];

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'operational-session-files-'));
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
    [11, { id: 11, name: 'A', root_path: projectA }],
    [12, { id: 12, name: 'B', root_path: projectB }],
  ]);
  const locator = new SessionLocator({
    dataDir,
    projectRootResolver: {
      resolveProjectRoot: (id) => projects.get(id)?.root_path,
      listProjectRoots: () =>
        [...projects.values()].map((project) => ({
          project_id: project.id,
          root_path: project.root_path,
        })),
    },
  });
  const repository = new FileSessionRepository({ locator });
  const catalog = new SessionCatalog({ locator, repository });
  const files = new OperationalSessionFiles({
    repository,
    catalog,
    locator,
    projects: {
      getProject: (id) => projects.get(id) ?? null,
    },
  });
  return { root, dataDir, projectA, projectB, files };
}

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('OperationalSessionFiles', () => {
  it('keeps single-project Company state in the project bundle and supports its UUID lifecycle', async () => {
    const { projectA, files } = await harness();
    const created = await files.createCompanySession({
      name: 'One project',
      project_ids: [11],
      config_json: '{"mode":"strict"}',
    });

    expect(created.id).toMatch(/^[0-9a-f-]{36}$/);
    const bundle = join(projectA, '.mcp-indexer', 'session', created.id);
    const session = JSON.parse(
      await readFile(join(bundle, 'session.json'), 'utf8'),
    ) as { kind: string; storage_scope: { kind: string }; metadata: unknown };
    expect(session.kind).toBe('company');
    expect(session.storage_scope.kind).toBe('project');

    await files.renameCompanySession(created.id, 'Renamed');
    await files.updateCompanySessionStatus(created.id, 'running');
    const full = await files.getCompanySessionFull(created.id);
    expect(full?.session).toMatchObject({
      id: created.id,
      name: 'Renamed',
      status: 'running',
      config_json: '{"mode":"strict"}',
    });
    expect(full?.projects).toEqual([
      {
        company_session_id: created.id,
        project_id: 11,
        label: null,
      },
    ]);

    expect(await files.deleteCompanySession(created.id)).toBe(true);
    expect(await files.getCompanySession(created.id)).toBeNull();
  });

  it('puts multi-project Company and App Studio sessions in global storage', async () => {
    const { dataDir, files } = await harness();
    const multi = await files.createCompanySession({
      name: 'Multi',
      project_ids: [11, 12],
    });
    const app = await files.createCompanySession({
      name: 'App',
      project_ids: [11],
      runtime_kind: 'app_studio',
    });

    for (const session of [multi, app]) {
      const metadata = JSON.parse(
        await readFile(
          join(dataDir, 'sessions', 'global', session.id, 'session.json'),
          'utf8',
        ),
      ) as { storage_scope: { kind: string } };
      expect(metadata.storage_scope.kind).toBe('global');
    }
    expect(app.runtime_kind).toBe('app_studio');
  });

  it('persists the Sprite project and asset lifecycle under its project session bundle', async () => {
    const { projectA, files } = await harness();
    const project = await files.createSpriteProject({
      project_id: 11,
      name: 'Sprites',
      style: { canvas: { width: 32, height: 32 } },
      settings: { zoom: 4 },
    });
    expect(project.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(
      await readFile(
        join(
          projectA,
          '.mcp-indexer',
          'session',
          project.id,
          'sprite',
          'project.json',
        ),
        'utf8',
      ),
    ).toContain('"sprite.project"');

    const asset = await files.createSpriteAsset(11, {
      name: 'Hero',
      status: 'draft',
      slug: 'hero',
      category: 'character',
      tags: [],
    });
    expect((await files.listSpriteAssets(11)).map((item) => item.id)).toEqual([
      asset.id,
    ]);
    await files.updateSpriteAsset(11, asset.id, {
      ...asset.data,
      status: 'approved',
    });
    expect((await files.getSpriteAsset(11, asset.id))?.data.status).toBe(
      'approved',
    );
    expect(await files.deleteSpriteAsset(11, asset.id)).toBe(true);
    expect(await files.getSpriteAsset(11, asset.id)).toBeNull();

    expect(await files.deleteSpriteProject(11)).toBe(true);
    expect(await files.getSpriteProject(11)).toBeNull();
  });

  it('fails closed when a linked project root is unavailable', async () => {
    const { files } = await harness();
    await expect(
      files.createCompanySession({
        name: 'Missing',
        project_ids: [999],
      }),
    ).rejects.toThrow('not registered');
    await expect(
      files.createSpriteProject({
        project_id: 999,
        name: 'Missing',
        style: {},
      }),
    ).rejects.toThrow('not registered');
  });
});

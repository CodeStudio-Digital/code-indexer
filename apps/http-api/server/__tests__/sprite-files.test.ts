import { mkdtemp, mkdir, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  FileSessionRepository,
  SessionCatalog,
  SessionLocator,
} from '@mcp/session-storage';
import { OperationalSessionFiles } from '../operational-session-files.js';
import { SpriteFileStore } from '../sprite-files.js';

const cleanup: string[] = [];

async function harness() {
  const root = await mkdtemp(join(tmpdir(), 'sprite-files-'));
  cleanup.push(root);
  const dataDir = join(root, 'data');
  const projectRoot = join(root, 'game');
  await Promise.all([
    mkdir(dataDir, { recursive: true }),
    mkdir(projectRoot, { recursive: true }),
  ]);
  const project = { id: 71, name: 'Game', root_path: projectRoot };
  const locator = new SessionLocator({
    dataDir,
    projectRootResolver: {
      resolveProjectRoot: (id) => id === project.id ? projectRoot : null,
      listProjectRoots: () => [{
        project_id: project.id,
        root_path: projectRoot,
      }],
    },
  });
  const repository = new FileSessionRepository({ locator });
  const catalog = new SessionCatalog({ locator, repository });
  const sessions = new OperationalSessionFiles({
    repository,
    catalog,
    locator,
    projects: {
      getProject: (id) => id === project.id ? project : null,
    },
  });
  const spriteProject = await sessions.createSpriteProject({
    project_id: project.id,
    name: 'Sprites',
    style: {
      canvas: { width: 32, height: 32, workingSize: 1024 },
      pixelPerfect: true,
    },
  });
  return {
    projectRoot,
    spriteProject,
    store: new SpriteFileStore(sessions),
  };
}

afterEach(async () => {
  await Promise.all(
    cleanup.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe('SpriteFileStore', () => {
  it('persists each operational record as its own UUID-addressed file', async () => {
    const { projectRoot, spriteProject, store } = await harness();
    const asset = await store.createAsset({
      sprite_project_id: spriteProject.id,
      slug: 'hero',
      display_name: 'Hero',
      category: 'character',
    });
    const version = await store.insertVersion({
      asset_id: asset.id,
      version: 1,
      file_rel_path: 'assets/hero/v001.png',
      width: 32,
      height: 32,
      source: 'generated',
      content_hash: 'a'.repeat(64),
    });
    await store.setCurrentVersion(asset.id, version.id);
    const animation = await store.createAnimation({
      asset_id: asset.id,
      name: 'idle',
      fps: 8,
      settings: { frameCount: 1, anchorVersionId: version.id },
    });
    const frames = await store.replaceFrames(animation.id, [{
      frame_index: 0,
      version_id: version.id,
      duration_ms: 125,
    }]);
    const job = await store.insertJob({
      sprite_project_id: spriteProject.id,
      asset_id: asset.id,
      kind: 'generate',
      user_intent: 'hero idle',
    });
    const projectReference = await store.insertReference({
      sprite_project_id: spriteProject.id,
      kind: 'style',
      file_rel_path: 'references/style.png',
    });
    const assetReference = await store.insertReference({
      sprite_project_id: spriteProject.id,
      asset_id: asset.id,
      kind: 'pose',
      file_rel_path: 'references/hero-pose.png',
    });
    await store.setJobResult(job.id, {
      result_version_id: version.id,
      provider_id: 'openai',
      model_id: 'gpt-image-1',
    });
    await store.updateJobStatus(job.id, 'done');

    for (const value of [asset.id, version.id, animation.id, frames[0].id, job.id]) {
      expect(value).toMatch(/^[0-9a-f-]{36}$/);
    }
    expect((await store.getAsset(asset.id))?.current_version_id).toBe(version.id);
    expect((await store.listFrames(animation.id))[0]).toMatchObject({
      version_id: version.id,
      track: 0,
    });
    expect(await store.getJob(job.id)).toMatchObject({
      status: 'done',
      result_version_id: version.id,
    });
    expect(
      (await store.listReferences(spriteProject.id, null)).map((item) => item.id),
    ).toEqual([projectReference.id]);
    expect(
      new Set(
        (await store.listReferences(spriteProject.id)).map((item) => item.id),
      ),
    ).toEqual(new Set([projectReference.id, assetReference.id]));

    const bundle = join(
      projectRoot,
      '.mcp-indexer',
      'session',
      spriteProject.id,
      'sprite',
    );
    const files = [
      join(bundle, 'assets', `${asset.id}.json`),
      join(bundle, 'versions', `${version.id}.json`),
      join(bundle, 'animations', `${animation.id}.json`),
      join(bundle, 'frames', `${frames[0].id}.json`),
      join(bundle, 'jobs', `${job.id}.json`),
    ];
    await Promise.all(files.map((file) => stat(file)));
    const persistedJob = JSON.parse(await readFile(files[4], 'utf8')) as {
      data: { result_version_id: string };
    };
    expect(persistedJob.data.result_version_id).toBe(version.id);
  });
});

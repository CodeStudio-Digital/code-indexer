import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsSessionStore } from '@mcp/code-agent/sessions/fs-store/index.js';
import { readFilesystemSkillUsageStats } from '../skill-usage-filesystem.js';

let root: string;
let projectRoot: string;
let store: FsSessionStore;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'mcp-skill-usage-fs-'));
  projectRoot = join(root, 'project');
  await Promise.all([mkdir(projectRoot), mkdir(join(root, 'data'))]);
  store = FsSessionStore.fromRoots({
    dataDir: join(root, 'data'),
    projectRootResolver: {
      resolveProjectRoot: (id) => (id === 9 ? projectRoot : null),
      listProjectRoots: () => [{ project_id: 9, root_path: projectRoot }],
    },
  });
});

afterEach(async () => {
  await store.close();
  await rm(root, { recursive: true, force: true });
});

describe('filesystem skill usage projection', () => {
  it('aggregates both event spellings across bundles without a global index', async () => {
    const first = await store.createSession({
      project_id: 9,
      title: 'one',
      provider: 'test',
      model: 'test',
    });
    const second = await store.createSession({
      project_id: 9,
      title: 'two',
      provider: 'test',
      model: 'test',
    });
    await store.appendSessionEvent(first.id, 'skill.usage', {
      skill_id: 'review',
      outcome: 'success',
    });
    await store.appendSessionEvent(second.id, 'skill_usage', {
      skill_id: 'review',
      outcome: 'failed',
      error_code: 'timeout',
    });
    await store.appendSessionEvent(second.id, 'skill_usage', {
      skill_id: 'other',
      outcome: 'failed',
      error_code: 'ignored',
    });

    expect(await readFilesystemSkillUsageStats(store, 'review')).toMatchObject({
      total_invocations: 2,
      success_rate: 0.5,
      top_error_codes: [{ code: 'timeout', count: 1 }],
    });
  });
});

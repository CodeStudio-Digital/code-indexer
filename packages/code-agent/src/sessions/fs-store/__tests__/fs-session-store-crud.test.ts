import { mkdir, mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FsSessionStore } from '../fs-session-store.js';

const SUBAGENT_RUN_ID = '11111111-1111-4111-8111-111111111111';
const OTHER_SUBAGENT_RUN_ID =
  '22222222-2222-4222-8222-222222222222';

let temporaryRoot: string;
let dataDir: string;
let projectOne: string;
let projectTwo: string;
let projectRoots: Map<number, string>;
let store: FsSessionStore;

beforeEach(async () => {
  temporaryRoot = await mkdtemp(join(tmpdir(), 'mcp-fs-session-store-'));
  dataDir = join(temporaryRoot, 'data');
  projectOne = join(temporaryRoot, 'project-one');
  projectTwo = join(temporaryRoot, 'project-two');
  await Promise.all([
    mkdir(dataDir),
    mkdir(projectOne),
    mkdir(projectTwo),
  ]);
  projectRoots = new Map([
    [1, projectOne],
    [2, projectTwo],
  ]);
  store = FsSessionStore.fromRoots({
    dataDir,
    projectRootResolver: {
      resolveProjectRoot: (projectId) => projectRoots.get(projectId),
      listProjectRoots: () => [...projectRoots].map(
        ([project_id, root_path]) => ({ project_id, root_path }),
      ),
    },
    projectInfoResolver: (projectId) => {
      const rootPath = projectRoots.get(projectId);
      return rootPath
        ? {
            project_id: projectId,
            name: projectId === 1 ? 'Alpha' : 'Beta',
            root_path: rootPath,
          }
        : null;
    },
  });
});

afterEach(async () => {
  await store.close();
  await rm(temporaryRoot, { recursive: true, force: true });
});

describe('FsSessionStore session catalog', () => {
  it('publishes creation-time runtime settings in the initial state projection', async () => {
    const session = await store.createSession({
      project_id: 1,
      title: 'Configured at publish',
      provider: 'openai',
      model: 'gpt-test',
      execution_mode_override: 'ultra',
      reasoning_effort_override: 'high',
      thinking_enabled: true,
    });

    expect(session).toMatchObject({
      execution_mode_override: 'ultra',
      reasoning_effort_override: 'high',
      thinking_enabled: true,
    });
    const persisted = JSON.parse(
      await readFile(
        join(
          projectOne,
          '.mcp-indexer',
          'session',
          String(session.id),
          'state.json',
        ),
        'utf8',
      ),
    ) as {
      extra: {
        runtime: {
          execution_mode_override: string;
          reasoning_effort_override: string | null;
          thinking_enabled: boolean;
        };
      };
    };
    expect(persisted.extra.runtime).toEqual({
      execution_mode_override: 'ultra',
      reasoning_effort_override: 'high',
      thinking_enabled: true,
    });
  });

  it('creates, lists and mutates normal/global UUID sessions without SQLite', async () => {
    const alpha = await store.createSession({
      project_id: 1,
      title: 'Alpha task',
      provider: 'anthropic',
      model: 'claude-test',
      agent: 'build',
    });
    const beta = await store.createSession({
      project_id: 2,
      title: 'Beta task',
      provider: 'openai',
      model: 'gpt-test',
    });
    const global = await store.createGlobalSession({
      title: 'Multi project',
      provider: 'openai',
      model: 'gpt-global',
      realProjects: [
        { projectId: 1, isPrimary: true, label: 'main' },
        { projectId: 2 },
      ],
    });

    expect(alpha.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );
    await Promise.all([
      stat(
        join(
          projectOne,
          '.mcp-indexer',
          'session',
          String(alpha.id),
          'session.json',
        ),
      ),
      stat(
        join(
          dataDir,
          'sessions',
          'global',
          String(global.id),
          'session.json',
        ),
      ),
    ]);

    expect((await store.listSessions(1)).map((session) => session.id)).toEqual([
      alpha.id,
    ]);
    expect((await store.listSessions(2)).map((session) => session.id)).toEqual([
      beta.id,
    ]);
    const globals = await store.listGlobalSessions();
    expect(globals).toHaveLength(1);
    expect(globals[0]).toMatchObject({
      id: global.id,
      project_name: 'Alpha',
      linked_count: 2,
      workspace_label: 'Alpha + Beta',
    });

    await store.setSessionFavorite(alpha.id, true);
    await store.setSessionTitle(alpha.id, 'Renamed');
    await store.updateSessionProvider(alpha.id, 'openai', 'gpt-next');
    await store.updateSessionStatus(alpha.id, 'running');
    const updated = await store.getSession(alpha.id);
    expect(updated).toMatchObject({
      title: 'Renamed',
      provider: 'openai',
      model: 'gpt-next',
      status: 'running',
      is_favorite: true,
      agent: 'build',
    });

    await store.setSessionArchived(alpha.id, true);
    expect(await store.listSessions(1)).toEqual([]);
    expect((await store.listSessions(1, { archived: true }))[0].id).toBe(
      alpha.id,
    );

    expect(await store.countSessionsForProject(1)).toBe(2);
    const trashed = await store.deleteSession(beta.id);
    expect(await store.getSession(beta.id)).toBeNull();
    await expect(stat(trashed.trash_path)).resolves.toBeDefined();
  });

  it('normalizes abandoned running sessions to interrupted', async () => {
    const session = await store.createSession({
      project_id: 1,
      title: 'Interrupted task',
      provider: 'test',
      model: 'test',
      status: 'running',
    });
    expect(await store.recoverStaleSessions()).toBe(1);
    expect((await store.getSession(session.id))?.status).toBe('interrupted');
    expect(await store.recoverStaleSessions()).toBe(0);
  });

  it('keeps a global bundle listable while revoking a removed project root', async () => {
    const session = await store.createGlobalSession({
      title: 'Surviving global session',
      provider: 'openai',
      model: 'gpt-test',
      owner_project_id: 1,
      realProjects: [
        { projectId: 1, isPrimary: true },
        { projectId: 2 },
      ],
    });

    projectRoots.delete(1);

    const listed = (await store.listGlobalSessions()).find(
      (candidate) => candidate.id === session.id,
    );
    expect(listed).toBeDefined();
    expect(listed?.linked_projects).toEqual([
      expect.objectContaining({
        project_id: 1,
        name: 'Alpha',
        root_path: '',
        is_primary: true,
      }),
      expect.objectContaining({
        project_id: 2,
        name: 'Beta',
        root_path: projectTwo,
      }),
    ]);
  });

  it('interrupts orphaned filesystem subagent runs at startup', async () => {
    const session = await store.createSession({
      project_id: 1,
      title: 'Subagent recovery',
      provider: 'test',
      model: 'test',
    });
    await expect(
      store.startSubagentRun({
        session_id: session.id,
        run_id: 'not-a-uuid',
        profile: 'implement',
        max_turns: 4,
      }),
    ).rejects.toThrow(/agent run id must be a canonical UUID/);
    const fence = await store.startSubagentRun({
      session_id: session.id,
      run_id: SUBAGENT_RUN_ID,
      profile: 'implement',
      max_turns: 4,
    });
    await expect(
      store.assertSubagentRunFence({
        ...fence,
        fence_token: 'not-a-fence-uuid',
      }),
    ).rejects.toThrow(/subagent fence_token must be a UUID/);
    await expect(
      store.completeSubagentRun({
        run_id: OTHER_SUBAGENT_RUN_ID,
        reason: 'completed',
        turns: 1,
        auto_continues: 0,
        tool_calls: 0,
        logical_operations: 0,
        productive_operations: 0,
        paginate_calls: 0,
        duplicate_calls: 0,
        error_calls: 0,
        refused_calls: 0,
        elapsed_ms: 1,
        input_tokens: 0,
        output_tokens: 0,
        has_summary: true,
        fence,
      }),
    ).rejects.toThrow(/terminal run\/fence mismatch/);
    await expect(store.assertSubagentRunFence(fence)).resolves.toBeUndefined();

    expect(await store.recoverOrphanedSubagentRuns()).toBe(1);
    await expect(store.assertSubagentRunFence(fence)).rejects.toThrow(
      'executor fence was lost',
    );
    expect(await store.recoverOrphanedSubagentRuns()).toBe(0);
  });

  it('links projects inside one global bundle and refuses unsafe detachments', async () => {
    const session = await store.createGlobalSession({
      title: 'Mutable roots',
      provider: 'openai',
      model: 'gpt-test',
      realProjects: [{ projectId: 1, isPrimary: true }],
    });

    const linked = await store.linkSessionProject(session.id, {
      project_id: 2,
      name: 'Beta',
      root_path: projectTwo,
      label: 'secondary',
    });
    expect(linked).toEqual([
      expect.objectContaining({ project_id: 1, is_primary: true }),
      expect.objectContaining({
        project_id: 2,
        is_primary: false,
        label: 'secondary',
      }),
    ]);

    const sessionPath = join(
      dataDir,
      'sessions',
      'global',
      String(session.id),
      'session.json',
    );
    const persisted = JSON.parse(await readFile(sessionPath, 'utf8')) as {
      linked_projects: Array<{ project_id: number; root_path: string }>;
      metadata: {
        coder: {
          linked_projects: Array<{
            project_id: number;
            is_primary: boolean;
          }>;
        };
      };
    };
    expect(persisted.linked_projects.map((project) => project.project_id)).toEqual([1, 2]);
    expect(persisted.metadata.coder.linked_projects).toEqual([
      expect.objectContaining({ project_id: 1, is_primary: true }),
      expect.objectContaining({ project_id: 2, is_primary: false }),
    ]);

    await expect(
      store.unlinkSessionProject(session.id, 1),
    ).rejects.toThrow('primary project');
    expect(await store.unlinkSessionProject(session.id, 2)).toEqual([
      expect.objectContaining({ project_id: 1, is_primary: true }),
    ]);
    await expect(
      store.linkSessionProject(session.id, {
        project_id: 2,
        name: 'Missing',
        root_path: join(temporaryRoot, 'missing'),
      }),
    ).rejects.toThrow('does not exist');
  });
});

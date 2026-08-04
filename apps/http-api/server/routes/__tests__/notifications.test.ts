import { beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mountNotificationRoutes, resolveNotificationSourceContext } from '../notifications.js';
import {
  clearNotificationEventBusForTests,
  publishNotificationRuntimeEvent,
} from '../../../sse/notification-event-bus.js';
import {
  asCompanySessionId,
  asSessionId,
} from '@mcp/session-storage';
import { FsSessionStore } from '@mcp/code-agent/sessions/fs-store/fs-session-store.js';

const CODER_ID = asSessionId(
  '00000000-0000-4000-8000-000000000012',
);
const GLOBAL_ID = asSessionId(
  '00000000-0000-4000-8000-000000000021',
);
const COMPANY_ID = asCompanySessionId(
  '00000000-0000-4000-8000-000000000008',
);
const COMPANY_ROOT_ID = asCompanySessionId(
  '00000000-0000-4000-8000-000000000003',
);

function deps(input: {
  coder?: Record<string, unknown>;
  company?: Record<string, unknown>;
  projectExists?: boolean;
}) {
  return {
    sessionStore: { getSession: async () => input.coder ?? null },
    resolveCompanyNotificationSession: async () => input.company ?? null,
    db: { getProject: () => input.projectExists === false ? undefined : { id: 7 } },
  } as never;
}

describe('notification route context', () => {
  beforeEach(() => clearNotificationEventBusForTests());

  it('targets an ordinary coder session by project and session', async () => {
    const context = await resolveNotificationSourceContext(
      deps({ coder: { id: CODER_ID, project_id: 7, is_global: false, title: 'Fix' } }),
      { kind: 'coder', sessionId: CODER_ID },
    );
    expect(context?.target).toEqual({
      kind: 'project',
      route: `/projects/7?session=${CODER_ID}`,
      scopeId: 7,
      sessionId: CODER_ID,
      label: 'Fix',
    });
  });

  it('targets a global coder session without exposing its synthetic project', async () => {
    const context = await resolveNotificationSourceContext(
      deps({ coder: { id: GLOBAL_ID, project_id: 99, is_global: true, title: 'Global' } }),
      { kind: 'coder', sessionId: GLOBAL_ID },
    );
    expect(context?.target).toEqual({
      kind: 'global',
      route: `/global?session=${GLOBAL_ID}`,
      sessionId: GLOBAL_ID,
      label: 'Global',
    });
  });

  it('routes a company child to its root/front and gives pipelines their tab', async () => {
    const context = await resolveNotificationSourceContext(
      deps({
        company: {
          id: COMPANY_ID,
          parent_session_id: COMPANY_ROOT_ID,
          name: 'Payments',
        },
      }),
      { kind: 'company', sessionId: COMPANY_ID },
    );
    expect(context?.target.route).toBe(
      `/company/sessions/${COMPANY_ROOT_ID}/${COMPANY_ID}/work/board`,
    );
    expect(context?.target.scopeId).toBe(COMPANY_ROOT_ID);
  });

  it('resolves Company notifications from the filesystem bundle by default', async () => {
    const root = await mkdtemp(join(tmpdir(), 'notification-company-files-'));
    const dataDir = join(root, 'data');
    const projectRoot = join(root, 'project');
    await Promise.all([mkdir(dataDir), mkdir(projectRoot)]);
    const sessionStore = FsSessionStore.fromRoots({
      dataDir,
      projectRootResolver: {
        resolveProjectRoot: (projectId) =>
          projectId === 7 ? projectRoot : null,
        listProjectRoots: () => [
          { project_id: 7, root_path: projectRoot },
        ],
      },
    });
    try {
      const company = await sessionStore.repository.createSession({
        id: asSessionId(COMPANY_ID),
        kind: 'company',
        scope: { kind: 'project', project_id: 7 },
        owner_project_id: 7,
        linked_projects: [{ project_id: 7 }],
        title: 'Filesystem Company',
        metadata: {
          name: 'Filesystem Company',
          runtime_kind: 'company',
        },
      });

      const context = await resolveNotificationSourceContext(
        {
          sessionStore,
          db: { getProject: () => ({ id: 7 }) },
        } as never,
        { kind: 'company', sessionId: company.session.id },
      );

      expect(context?.target).toMatchObject({
        kind: 'company',
        route: `/company/sessions/${COMPANY_ID}/main/work/board`,
        scopeId: COMPANY_ID,
        sessionId: COMPANY_ID,
        label: 'Filesystem Company',
      });
    } finally {
      await sessionStore.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('does not replay the ring on a cold connection but replays after Last-Event-ID', async () => {
    const app = new Hono();
    mountNotificationRoutes(
      app,
      deps({ coder: { id: CODER_ID, project_id: 7, is_global: false, title: 'Fix' } }),
    );
    publishNotificationRuntimeEvent({
      kind: 'coder', sessionId: CODER_ID, event: 'done', data: { reason: 'first' },
    });

    const cold = await app.request('/api/notifications/stream');
    const coldReader = cold.body!.getReader();
    const coldChunk = new TextDecoder().decode((await coldReader.read()).value);
    expect(coldChunk).toContain('event: cursor');
    expect(coldChunk).not.toContain('event: notification');
    await coldReader.cancel();

    publishNotificationRuntimeEvent({
      kind: 'coder', sessionId: CODER_ID, event: 'done', data: { reason: 'second' },
    });
    const replay = await app.request('/api/notifications/stream', {
      headers: { 'Last-Event-ID': '1' },
    });
    const replayReader = replay.body!.getReader();
    const replayChunk = new TextDecoder().decode((await replayReader.read()).value);
    expect(replayChunk).toContain('event: notification');
    expect(replayChunk).toContain('"id":2');
    await replayReader.cancel();
  });
});

import { beforeEach, describe, expect, it } from 'vitest';
import { Hono } from 'hono';
import { mountNotificationRoutes, resolveNotificationSourceContext } from '../notifications.js';
import {
  clearNotificationEventBusForTests,
  publishNotificationRuntimeEvent,
} from '../../../sse/notification-event-bus.js';

function deps(input: {
  coder?: Record<string, unknown>;
  company?: Record<string, unknown>;
  projectExists?: boolean;
}) {
  return {
    sessionStore: { getSession: () => input.coder ?? null },
    companyStore: { getCompanySession: () => input.company ?? null },
    db: { getProject: () => input.projectExists === false ? undefined : { id: 7 } },
  } as never;
}

describe('notification route context', () => {
  beforeEach(() => clearNotificationEventBusForTests());

  it('targets an ordinary coder session by project and session', () => {
    const context = resolveNotificationSourceContext(
      deps({ coder: { id: 12, project_id: 7, is_global: false, title: 'Fix' } }),
      { kind: 'coder', sessionId: 12 },
    );
    expect(context?.target).toEqual({
      kind: 'project',
      route: '/projects/7?session=12',
      scopeId: 7,
      sessionId: 12,
      label: 'Fix',
    });
  });

  it('targets a global coder session without exposing its synthetic project', () => {
    const context = resolveNotificationSourceContext(
      deps({ coder: { id: 21, project_id: 99, is_global: true, title: 'Global' } }),
      { kind: 'coder', sessionId: 21 },
    );
    expect(context?.target).toEqual({
      kind: 'global',
      route: '/global?session=21',
      sessionId: 21,
      label: 'Global',
    });
  });

  it('routes a company child to its root/front and gives pipelines their tab', () => {
    const context = resolveNotificationSourceContext(
      deps({ company: { id: 8, parent_session_id: 3, name: 'Payments' } }),
      { kind: 'company', sessionId: 8 },
    );
    expect(context?.target.route).toBe('/company/sessions/3/8/work/board');
    expect(context?.pipelineTarget?.route).toBe('/company/sessions/3/8/work/pipelines');
    expect(context?.target.scopeId).toBe(3);
  });

  it('does not replay the ring on a cold connection but replays after Last-Event-ID', async () => {
    const app = new Hono();
    mountNotificationRoutes(
      app,
      deps({ coder: { id: 12, project_id: 7, is_global: false, title: 'Fix' } }),
    );
    publishNotificationRuntimeEvent({
      kind: 'coder', sessionId: 12, event: 'done', data: { reason: 'first' },
    });

    const cold = await app.request('/api/notifications/stream');
    const coldReader = cold.body!.getReader();
    const coldChunk = new TextDecoder().decode((await coldReader.read()).value);
    expect(coldChunk).toContain('event: cursor');
    expect(coldChunk).not.toContain('event: notification');
    await coldReader.cancel();

    publishNotificationRuntimeEvent({
      kind: 'coder', sessionId: 12, event: 'done', data: { reason: 'second' },
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

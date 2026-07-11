import type { Hono } from 'hono';
import { streamSSE } from 'hono/streaming';
import type { ServerDeps } from '../deps.js';
import { attachHeartbeat } from '../../sse/SSEHeartbeat.js';
import {
  latestNotificationRuntimeEventId,
  recentNotificationRuntimeEvents,
  subscribeToNotificationRuntimeEvents,
  type NotificationRuntimeEvent,
} from '../../sse/notification-event-bus.js';

export interface NotificationRouteTarget {
  kind: 'project' | 'global' | 'company';
  route: string;
  scopeId?: number;
  sessionId: number;
  label: string;
}

export interface NotificationSourceContext {
  target: NotificationRouteTarget;
  pipelineTarget?: NotificationRouteTarget;
}

export interface NotificationStreamEnvelope extends NotificationRuntimeEvent {
  context: NotificationSourceContext;
}

type NotificationRouteDeps = Pick<ServerDeps, 'sessionStore' | 'companyStore' | 'db'>;

/**
 * One app-wide SSE connection for native/toast and unread notifications.
 * A cold connection starts at the current high-water mark; reconnects replay
 * only the bounded notification ring after Last-Event-ID.
 */
export function mountNotificationRoutes(app: Hono, deps: NotificationRouteDeps): void {
  app.get('/api/notifications/stream', (c) => {
    const requestedCursor = parseCursor(c.req.header('Last-Event-ID'));
    return streamSSE(c, async (stream) => {
      const latestAtOpen = latestNotificationRuntimeEventId();
      const cursor = requestedCursor == null || requestedCursor > latestAtOpen
        ? latestAtOpen
        : requestedCursor;
      let writes = Promise.resolve<unknown>(undefined);
      const enqueue = (
        id: number,
        event: 'notification' | 'cursor',
        data: unknown,
      ): void => {
        writes = writes
          .then(() => stream.writeSSE({ id: String(id), event, data: JSON.stringify(data) }))
          .catch(() => undefined);
      };
      const forward = (source: NotificationRuntimeEvent): void => {
        const context = resolveNotificationSourceContext(deps, source);
        if (!context) {
          enqueue(source.id, 'cursor', { ts: source.ts });
          return;
        }
        enqueue(source.id, 'notification', { ...source, context } satisfies NotificationStreamEnvelope);
      };

      // Subscribe before taking the replay snapshot. JavaScript cannot run a
      // publisher between these synchronous calls, so no live event falls in
      // the hand-off gap; queued writes preserve replay-before-live ordering.
      const unsubscribe = subscribeToNotificationRuntimeEvents(forward);
      if (requestedCursor != null && requestedCursor <= latestAtOpen) {
        for (const event of recentNotificationRuntimeEvents(cursor)) forward(event);
      }
      enqueue(latestAtOpen, 'cursor', { ts: Date.now() });

      const stopHeartbeat = attachHeartbeat(stream);
      await new Promise<void>((resolve) => {
        stream.onAbort(() => {
          unsubscribe();
          stopHeartbeat();
          resolve();
        });
      });
    });
  });
}

export function resolveNotificationSourceContext(
  deps: NotificationRouteDeps,
  source: Pick<NotificationRuntimeEvent, 'kind' | 'sessionId'>,
): NotificationSourceContext | null {
  if (source.kind === 'coder') {
    const session = deps.sessionStore.getSession(source.sessionId);
    if (!session) return null;
    if (session.is_global) {
      return {
        target: {
          kind: 'global',
          route: `/global?session=${session.id}`,
          sessionId: session.id,
          label: session.title,
        },
      };
    }
    if (!deps.db.getProject(session.project_id)) return null;
    const target: NotificationRouteTarget = {
      kind: 'project',
      route: `/projects/${session.project_id}?session=${session.id}`,
      scopeId: session.project_id,
      sessionId: session.id,
      label: session.title,
    };
    return { target, pipelineTarget: target };
  }

  const session = deps.companyStore.getCompanySession(source.sessionId);
  if (!session) return null;
  const rootId = session.parent_session_id ?? session.id;
  const front = session.id === rootId ? 'main' : String(session.id);
  const base = `/company/sessions/${rootId}/${front}/work`;
  const target: NotificationRouteTarget = {
    kind: 'company',
    route: `${base}/board`,
    scopeId: rootId,
    sessionId: session.id,
    label: session.name,
  };
  return {
    target,
    pipelineTarget: { ...target, route: `${base}/pipelines` },
  };
}

function parseCursor(raw: string | undefined): number | null {
  if (raw == null || raw.trim() === '') return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

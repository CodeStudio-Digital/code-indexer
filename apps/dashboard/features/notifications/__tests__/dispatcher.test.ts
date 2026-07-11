import { describe, expect, it } from 'vitest';
import {
  buildNotificationKey,
  isNotificationRouteVisibleForLocation,
  settingsFromResponse,
} from '../dispatcher.js';
import type { AppNotificationEvent, NotificationRouteTarget } from '../types.js';

describe('notification route visibility', () => {
  it('matches project routes by project id and session query', () => {
    const target: NotificationRouteTarget = {
      kind: 'project',
      route: '/projects/42?session=7',
      scopeId: 42,
      sessionId: 7,
    };

    expect(isNotificationRouteVisibleForLocation(target, {
      pathname: '/projects/42',
      search: '?session=7&tab=chat',
      visibilityState: 'visible',
    })).toBe(true);

    expect(isNotificationRouteVisibleForLocation(target, {
      pathname: '/projects/42',
      search: '?session=8',
      visibilityState: 'visible',
    })).toBe(false);
  });

  it('matches global routes by session query', () => {
    const target: NotificationRouteTarget = {
      kind: 'global',
      route: '/global?session=12',
      sessionId: 12,
    };

    expect(isNotificationRouteVisibleForLocation(target, {
      pathname: '/global',
      search: '?session=12',
      visibilityState: 'visible',
    })).toBe(true);
  });

  it('matches company routes by canonical board or pipeline path', () => {
    const board: NotificationRouteTarget = {
      kind: 'company',
      route: '/company/sessions/5/main/work/board',
      scopeId: 5,
      sessionId: 5,
    };

    expect(isNotificationRouteVisibleForLocation(board, {
      pathname: '/company/sessions/5/main/work/board',
      visibilityState: 'visible',
    })).toBe(true);

    expect(isNotificationRouteVisibleForLocation(board, {
      pathname: '/company/sessions/5/main/work/pipelines',
      visibilityState: 'visible',
    })).toBe(false);
  });

  it('never treats hidden documents as visible', () => {
    expect(isNotificationRouteVisibleForLocation({
      kind: 'global',
      route: '/global?session=1',
      sessionId: 1,
    }, {
      pathname: '/global',
      search: '?session=1',
      visibilityState: 'hidden',
    })).toBe(false);
  });
});

describe('notification settings and dedupe keys', () => {
  it('reads bool settings from the admin settings response', () => {
    expect(settingsFromResponse({
      items: [
        { key: 'MCP_DESKTOP_NOTIFICATIONS_ENABLED', value: '0' },
        { key: 'MCP_DESKTOP_NOTIFY_ACTION_REQUIRED', value: 'false' },
        { key: 'MCP_DESKTOP_NOTIFY_SESSION_FINISHED', value: '1' },
      ],
    })).toEqual({
      enabled: false,
      actionRequired: false,
      sessionFinished: true,
    });
  });

  it('builds stable keys from kind, scope, session, and event id', () => {
    const event: AppNotificationEvent = {
      kind: 'human_action_required',
      target: {
        kind: 'project',
        route: '/projects/2?session=9',
        scopeId: 2,
        sessionId: 9,
      },
      id: 'tool_approval_request:abc',
      title: 'Action required',
      body: 'Waiting for approval.',
    };

    expect(buildNotificationKey(event)).toBe(
      'mcp.desktop-notification:human_action_required:project:2:9:tool_approval_request:abc',
    );
  });

  it('uses the runtime identity so repeated semantic outcomes remain distinct runs', () => {
    const base: AppNotificationEvent = {
      kind: 'session_finished',
      target: { kind: 'project', route: '/projects/2?session=9', scopeId: 2, sessionId: 9 },
      id: 'done:completed:',
      title: 'Finished',
      body: 'Done.',
    };
    expect(buildNotificationKey({ ...base, dedupeKey: 'runtime:1000:1' }))
      .not.toBe(buildNotificationKey({ ...base, dedupeKey: 'runtime:2000:2' }));
  });
});

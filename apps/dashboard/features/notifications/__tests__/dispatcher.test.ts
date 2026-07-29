import { describe, expect, it } from 'vitest';
import {
  buildNotificationKey,
  isNotificationRouteVisibleForLocation,
  settingsFromResponse,
} from '../dispatcher.js';
import type { AppNotificationEvent, NotificationRouteTarget } from '../types.js';

const PROJECT_SESSION_ID = '55555555-5555-4555-8555-555555555555';
const OTHER_PROJECT_SESSION_ID = '66666666-6666-4666-8666-666666666666';
const GLOBAL_SESSION_ID = '77777777-7777-4777-8777-777777777777';
const COMPANY_SESSION_ID = '88888888-8888-4888-8888-888888888888';

describe('notification route visibility', () => {
  it('matches project routes by project id and session query', () => {
    const target: NotificationRouteTarget = {
      kind: 'project',
      route: `/projects/42?session=${PROJECT_SESSION_ID}`,
      scopeId: 42,
      sessionId: PROJECT_SESSION_ID,
    };

    expect(isNotificationRouteVisibleForLocation(target, {
      pathname: '/projects/42',
      search: `?session=${PROJECT_SESSION_ID}&tab=chat`,
      visibilityState: 'visible',
    })).toBe(true);

    expect(isNotificationRouteVisibleForLocation(target, {
      pathname: '/projects/42',
      search: `?session=${OTHER_PROJECT_SESSION_ID}`,
      visibilityState: 'visible',
    })).toBe(false);
  });

  it('matches global routes by session query', () => {
    const target: NotificationRouteTarget = {
      kind: 'global',
      route: `/global?session=${GLOBAL_SESSION_ID}`,
      sessionId: GLOBAL_SESSION_ID,
    };

    expect(isNotificationRouteVisibleForLocation(target, {
      pathname: '/global',
      search: `?session=${GLOBAL_SESSION_ID}`,
      visibilityState: 'visible',
    })).toBe(true);
  });

  it('matches company routes by canonical board or pipeline path', () => {
    const board: NotificationRouteTarget = {
      kind: 'company',
      route: `/company/sessions/${COMPANY_SESSION_ID}/main/work/board`,
      scopeId: COMPANY_SESSION_ID,
      sessionId: COMPANY_SESSION_ID,
    };

    expect(isNotificationRouteVisibleForLocation(board, {
      pathname: `/company/sessions/${COMPANY_SESSION_ID}/main/work/board`,
      visibilityState: 'visible',
    })).toBe(true);

    expect(isNotificationRouteVisibleForLocation(board, {
      pathname: `/company/sessions/${COMPANY_SESSION_ID}/main/work/pipelines`,
      visibilityState: 'visible',
    })).toBe(false);
  });

  it('never treats hidden documents as visible', () => {
    expect(isNotificationRouteVisibleForLocation({
      kind: 'global',
      route: `/global?session=${GLOBAL_SESSION_ID}`,
      sessionId: GLOBAL_SESSION_ID,
    }, {
      pathname: '/global',
      search: `?session=${GLOBAL_SESSION_ID}`,
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
        route: `/projects/2?session=${PROJECT_SESSION_ID}`,
        scopeId: 2,
        sessionId: PROJECT_SESSION_ID,
      },
      id: 'tool_approval_request:abc',
      title: 'Action required',
      body: 'Waiting for approval.',
    };

    expect(buildNotificationKey(event)).toBe([
      'mcp.desktop-notification',
      'human_action_required',
      'project',
      '2',
      PROJECT_SESSION_ID,
      'tool_approval_request:abc',
    ].join(':'));
  });

  it('uses the runtime identity so repeated semantic outcomes remain distinct runs', () => {
    const base: AppNotificationEvent = {
      kind: 'session_finished',
      target: {
        kind: 'project',
        route: `/projects/2?session=${PROJECT_SESSION_ID}`,
        scopeId: 2,
        sessionId: PROJECT_SESSION_ID,
      },
      id: 'done:completed:',
      title: 'Finished',
      body: 'Done.',
    };
    expect(buildNotificationKey({ ...base, dedupeKey: 'runtime:1000:1' }))
      .not.toBe(buildNotificationKey({ ...base, dedupeKey: 'runtime:2000:2' }));
  });
});

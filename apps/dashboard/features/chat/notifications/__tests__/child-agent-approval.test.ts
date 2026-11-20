/**
 * A child agent's approval prompt in its parent's notification center: the
 * runtime event adds a notice that stays until answered, its row links to the
 * child's chat, and the resolved event marks it answered and takes it off
 * the banner.
 */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it } from 'vitest';
import i18n from 'i18next';
import { bootstrapTestI18n } from '../../../../i18n/test-bootstrap.js';
import { NotificationRow } from '../NotificationRow.js';
import { recordCoderRuntimeNotification } from '../runtime-events.js';
import { getActiveNotifications, getNotifications } from '../session-notifications-store.js';

const PARENT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const CHILD = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const attention = (id: number, state: string, projectId: number | null = 7) => recordCoderRuntimeNotification({
  id, ts: id, sessionId: PARENT, event: 'child_agent_attention', data: { childId: CHILD, childTitle: 'Fix the parser', projectId, state },
});

beforeAll(async () => {
  await bootstrapTestI18n();
  await i18n.changeLanguage('en');
});

describe('child-agent approval notice', () => {
  it('stays until answered, links to the child chat, and resolves', () => {
    attention(1, 'awaiting_approval');
    attention(1, 'awaiting_approval'); // a replayed stream event
    const [notice] = getNotifications(PARENT);
    expect(getNotifications(PARENT)).toHaveLength(1);
    expect(notice).toMatchObject({ severity: 'warning', autoDismissMs: null, dismissed: false,
      payload: { kind: 'child-agent-approval', childId: CHILD, projectId: 7, resolved: false } });
    const html = renderToStaticMarkup(createElement(NotificationRow, { sessionId: PARENT, notification: notice!, mode: 'history' }));
    expect(html).toContain('Child agent needs approval');
    expect(html).toContain('Fix the parser is waiting for an approval.');
    expect(html).toContain(`href="#/projects/7?session=${CHILD}"`);

    attention(2, 'resolved');
    const [resolved] = getNotifications(PARENT);
    expect(resolved).toMatchObject({ dismissed: true, severity: 'info', payload: { resolved: true } });
    expect(getActiveNotifications(PARENT)).toHaveLength(0);
    expect(renderToStaticMarkup(createElement(NotificationRow, { sessionId: PARENT, notification: resolved!, mode: 'history' })))
      .toContain('answered');
  });

  it('tells the chat a stop came from how many child chats it stopped, and why', () => {
    const OTHER = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    recordCoderRuntimeNotification({ id: 9, ts: 9, sessionId: OTHER, event: 'child_agents_stopped', data: { count: 3, reason: 'stopped_by_user' } });
    recordCoderRuntimeNotification({ id: 10, ts: 10, sessionId: OTHER, event: 'child_agents_stopped', data: { count: 0, reason: 'stopped_by_user' } });
    const items = getNotifications(OTHER);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ severity: 'info', payload: { kind: 'child-agents-stopped', count: 3, reason: 'stopped_by_user' } });
    const html = renderToStaticMarkup(createElement(NotificationRow, { sessionId: OTHER, notification: items[0]!, mode: 'history' }));
    expect(html).toContain('3 child chats stopped');
    expect(html).toContain('Nothing queued will start.');
  });

  it('links a global child session to the global route', () => {
    attention(3, 'awaiting_approval', null);
    const latest = getNotifications(PARENT).at(-1)!;
    expect(renderToStaticMarkup(createElement(NotificationRow, { sessionId: PARENT, notification: latest, mode: 'history' })))
      .toContain(`href="#/global?session=${CHILD}"`);
  });
});

import type { Hono } from 'hono';
import { ChatCollaborationStore, rootChatId } from '@mcp/session-storage/collaboration/store.js';
import type { ServerDeps } from '../../deps.js';
import type { CoderRuntime } from './state.js';
import { parseSessionIdParam, parseJsonBody, notFound } from '../_helpers.js';
import { registerShutdownTask } from '../../shutdown-tasks.js';
import { startCollaborationWakeService, wakeCollaboratingChat } from './chat-collaboration-wake.js';

export function mountChatCollaborationRoutes(app: Hono, deps: ServerDeps, runtime: CoderRuntime): void {
  const mailbox = new ChatCollaborationStore(deps.sessionStore.locator.dataDir);
  const ready = mailbox.init();
  const service = ready.then(() => startCollaborationWakeService(mailbox, message => wakeCollaboratingChat(deps, runtime, mailbox, message)));
  void service.catch(error => console.error('[chat-collaboration] startup failed:', error));
  registerShutdownTask('chat-collaboration', async () => { const stop = await service; await stop(); });
  app.get('/api/coder/sessions/:id/collaboration', async c => {
    await ready; const id = parseSessionIdParam(c);
    const session = await deps.sessionStore.getSession(id); if (!session) return notFound(c);
    const actor = rootChatId(id);
    if (!await mailbox.participant(actor)) await mailbox.registerRoot(id, session.title);
    const peers = await mailbox.peers(actor);
    const members = new Set([actor, ...peers.filter(peer => peer.sessionId === id).map(peer => peer.id)]);
    const messages = (await mailbox.messages(undefined, 500)).filter(row => members.has(row.from) || members.has(row.to));
    const sessions = session.project_id == null ? await deps.sessionStore.listGlobalSessions() : await deps.sessionStore.listSessions(session.project_id);
    return c.json({ self: actor, peers, messages: messages.slice(0, 100),
      stopped: (await mailbox.participant(actor))?.state === 'stopped',
      candidates: sessions.filter(row => row.id !== id && !row.is_archived).map(row => ({ id: row.id, title: row.title })),
      policy: await mailbox.files.get('policies', id) });
  });
  app.put('/api/coder/sessions/:id/collaboration/links', async c => {
    await ready; const id = parseSessionIdParam(c);
    const body = await parseJsonBody<{ sessionId?: string; enabled?: boolean }>(c);
    if (!body.sessionId || typeof body.enabled !== 'boolean') return c.json({ error: 'sessionId and enabled are required' }, 400);
    const left = await deps.sessionStore.getSession(id), right = await deps.sessionStore.getSession(body.sessionId);
    if (!left || !right) return notFound(c);
    if (!await mailbox.participant(rootChatId(id))) await mailbox.registerRoot(id, left.title);
    if (!await mailbox.participant(rootChatId(right.id))) await mailbox.registerRoot(right.id, right.title);
    await mailbox.linkSessions(id, right.id, body.enabled); return c.json({ linked: body.enabled });
  });
  app.post('/api/coder/sessions/:id/collaboration/stop', async c => {
    await ready; const id = parseSessionIdParam(c);
    if (!await deps.sessionStore.getSession(id)) return notFound(c);
    await mailbox.stopSession(id); return c.json({ stopped: true });
  });
  app.post('/api/coder/sessions/:id/collaboration/resume', async c => {
    await ready; const id = parseSessionIdParam(c);
    if (!await deps.sessionStore.getSession(id)) return notFound(c);
    for (const peer of await mailbox.files.list<import('@mcp/session-storage/collaboration/types.js').ChatParticipant>('participants')) {
      if (peer.sessionId === id && peer.state === 'stopped') await mailbox.register({ ...peer, state: 'idle' });
    }
    return c.json({ stopped: false });
  });
}

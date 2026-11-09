import type { Hono } from 'hono';
import { ChatCollaborationStore, rootChatId } from '@mcp/session-storage/collaboration/store.js';
import type { ServerDeps } from '../../deps.js';
import type { CoderRuntime } from './state.js';
import { parseSessionIdParam, parseJsonBody, notFound } from '../_helpers.js';
import { registerShutdownTask } from '../../shutdown-tasks.js';
import { startCollaborationWakeService, wakeCollaboratingChat } from './chat-collaboration-wake.js';
import { SessionNetwork } from '@mcp/code-agent/runtime/session-network.js';
import { deliverNetworkTriggers } from '@mcp/code-agent/runtime/session-network-events.js';
import type { ChatTrigger } from '@mcp/session-storage/collaboration/network-types.js';
import { mountSessionNetworkRoutes } from './session-network-routes.js';
import { ChatScheduler } from '@mcp/code-agent/runtime/chat-scheduler.js';
import { mountUltraFollowupRoutes } from './ultra-followups.js';
import type { ChatNetworkSnapshot } from '@mcp/agent-runtime-contracts/chat-network.js';

export function mountChatCollaborationRoutes(app: Hono, deps: ServerDeps, runtime: CoderRuntime): void {
  const mailbox = new ChatCollaborationStore(deps.sessionStore.locator.dataDir);
  const ready = mailbox.init();
  const network = new SessionNetwork({ sessions: deps.sessionStore, mailbox, project: id => deps.db.getProject(id),
    validateModel: (provider, model) => {
      if (!deps.providerStore.getProvider(provider)?.enabled || !deps.providerStore.listModels(provider, true)
        .some(row => `${row.model_id}${row.mode ? `::${row.mode}` : ''}` === model)) throw new Error('Unknown or disabled provider/model');
    } });
  mountSessionNetworkRoutes(app, deps, network, ready);
  const scheduler = new ChatScheduler(mailbox);
  mountUltraFollowupRoutes(app, network, scheduler, ready);
  const service = ready.then(() => startCollaborationWakeService(mailbox, message => wakeCollaboratingChat(deps, runtime, mailbox, message, network, scheduler), async () => {
    await network.synchronize();
    await deliverNetworkTriggers(network);
    await scheduler.tick();
  }));
  void service.catch(error => console.error('[chat-collaboration] startup failed:', error));
  registerShutdownTask('chat-collaboration', async () => { const stop = await service; await stop(); });

  app.get('/api/coder/sessions/:id/collaboration', async c => {
    await ready;
    const id = parseSessionIdParam(c);
    const session = await network.session(id).catch(() => null);
    if (!session) return notFound(c);
    const actor = rootChatId(id);
    if (!await mailbox.participant(actor)) await mailbox.registerRoot(id, session.title);
    const peers = await mailbox.peers(actor);
    const members = new Set([actor, ...peers.map(peer => peer.id)]);
    const messages = (await mailbox.messages(undefined, 500)).filter(row => members.has(row.from) && members.has(row.to));
    const candidates = await network.discover(id);
    const config = await network.config(id);
    const root = await network.config(config.rootId);
    const visible = new Set([id, ...peers.map(peer => peer.sessionId)]);
    const links = (await mailbox.files.list<{ sessions: string[]; enabled: boolean }>('links')).filter(link => link.enabled && link.sessions.every(sid => visible.has(sid)));
    const triggers = (await mailbox.files.list<ChatTrigger>('triggers')).filter(trigger => visible.has(trigger.ownerSessionId) && visible.has(trigger.sourceSessionId) && visible.has(trigger.targetSessionId));
    const wakeCount = (await mailbox.files.list<{ rootId: string; budgetId: string }>('wake-slots')).filter(slot => slot.rootId === root.rootId && slot.budgetId === root.budgetId).length;
    const chats = (await Promise.all([...visible].slice(0, 33).map(chatId => network.session(chatId).catch(() => null)))).filter(chat => chat != null)
      .map(chat => ({ id: chat.id, title: chat.title, projectId: chat.project_id, provider: chat.provider, model: chat.model }));
    const projects = [...new Set([...config.projectIds, ...root.projectIds])].flatMap(pid => {
      const project = deps.db.getProject(pid);
      return project && !project.is_synthetic ? [{ id: pid, name: project.name }] : [];
    });
    return c.json({ self: actor, stopped: (await mailbox.participant(actor))?.state === 'stopped', peers, messages: messages.slice(0, 100),
      candidates: candidates.filter(candidate => candidate.id !== id).map(candidate => ({ id: candidate.id, title: candidate.title })),
      config, links, triggers, wakeCount, rootBudget: root.maxWakeups, chats, projects,
      policy: await mailbox.files.get<ChatNetworkSnapshot['policy']>('policies', id),
    } satisfies ChatNetworkSnapshot);
  });
  app.put('/api/coder/sessions/:id/collaboration/links', async c => {
    await ready;
    const id = parseSessionIdParam(c);
    const body = await parseJsonBody<{ sessionId?: string; enabled?: boolean }>(c);
    if (!body.sessionId || typeof body.enabled !== 'boolean') return c.json({ error: 'sessionId and enabled are required' }, 400);
    const left = await deps.sessionStore.getSession(id);
    const right = await deps.sessionStore.getSession(body.sessionId);
    if (!left || !right) return notFound(c);
    try {
      if (!await mailbox.participant(rootChatId(id))) await mailbox.registerRoot(id, left.title);
      if (!await mailbox.participant(rootChatId(right.id))) await mailbox.registerRoot(right.id, right.title);
      await mailbox.linkSessions(id, right.id, body.enabled);
      return c.json({ linked: body.enabled });
    } catch (error) { return c.json({ error: String(error) }, 400); }
  });
  app.post('/api/coder/sessions/:id/collaboration/stop', async c => {
    await ready;
    const id = parseSessionIdParam(c);
    if (!await deps.sessionStore.getSession(id)) return notFound(c);
    await network.settings(id, { enabled: false });
    await mailbox.stopSession(id);
    return c.json({ stopped: true });
  });
  app.post('/api/coder/sessions/:id/collaboration/resume', async c => {
    await ready;
    const id = parseSessionIdParam(c);
    if (!await deps.sessionStore.getSession(id)) return notFound(c);
    for (const peer of await mailbox.files.list<import('@mcp/session-storage/collaboration/types.js').ChatParticipant>('participants')) {
      if (peer.sessionId === id && peer.state === 'stopped') await mailbox.register({ ...peer, state: 'idle' });
    }
    return c.json({ stopped: false });
  });
}

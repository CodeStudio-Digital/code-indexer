import type { Hono } from 'hono';
import type { ServerDeps } from '../../deps.js';
import type { SessionNetwork } from '@mcp/code-agent/runtime/session-network.js';
import type { ChatSpawnInput, ChatTrigger } from '@mcp/session-storage/collaboration/network-types.js';
import { rootChatId } from '@mcp/session-storage/collaboration/store.js';
import { parseJsonBody, parseSessionIdParam } from '../_helpers.js';

export function mountSessionNetworkRoutes(app: Hono, deps: ServerDeps, network: SessionNetwork, ready: Promise<void>) {
  const base = '/api/coder/sessions/:id/collaboration';
  app.get(`${base}/settings`, async c => { await ready; return c.json(await network.config(parseSessionIdParam(c))); });
  app.put(`${base}/settings`, async c => {
    await ready;
    const id = parseSessionIdParam(c);
    const body = await parseJsonBody<{ enabled?: boolean; projectIds?: number[]; role?: string; maxSessions?: number; maxWakeups?: number; resetBudget?: boolean }>(c);
    try {
      const { resetBudget, ...patch } = body;
      const config = await network.settings(id, patch, resetBudget === true);
      const participant = await network.mailbox.participant(rootChatId(id));
      if (config.enabled && (!participant || participant.state === 'stopped')) await network.mailbox.registerRoot(id, (await network.session(id)).title);
      return c.json(config);
    } catch (error) { return c.json({ error: String(error) }, 400); }
  });
  app.get(`${base}/suggestions`, async c => {
    await ready;
    const id = parseSessionIdParam(c), query = (c.req.query('query') ?? '').toLowerCase().slice(0, 100);
    await network.session(id);
    if (c.req.query('kind') === 'projects') return c.json({ items: deps.db.listProjectsForGlobalPicker()
      .filter(project => !project.is_synthetic && project.root_path && project.name.toLowerCase().includes(query)).slice(0, 50)
      .map(project => ({ id: String(project.id), label: project.name, detail: project.root_path, kind: 'project' })) });
    const session = await network.session(id);
    if (!await network.mailbox.participant(rootChatId(id))) await network.mailbox.registerRoot(id, session.title);
    const chats = await network.discover(id, query);
    for (const pid of (c.req.query('project_ids') ?? '').split(',').filter(Boolean).slice(0, 32).map(Number)) {
      network.requireProject(pid);
      for (const chat of await deps.sessionStore.listSessions(pid)) if (chat.id !== id && chat.title.toLowerCase().includes(query)) chats.push({ id: chat.id, chatId: rootChatId(chat.id), title: chat.title, projectId: pid, provider: chat.provider, model: chat.model, status: chat.status });
    }
    return c.json({ items: [...new Map(chats.map(chat => [chat.id, chat])).values()].slice(0, 50).map(chat => ({ id: chat.id, label: chat.title, detail: `${chat.status} · ${chat.model}`, kind: 'chat' })) });
  });
  app.post(`${base}/references`, async c => {
    await ready;
    const body = await parseJsonBody<{ chatIds?: string[]; projectIds?: number[] }>(c);
    if (!Array.isArray(body.chatIds) || !Array.isArray(body.projectIds)) return c.json({ error: 'Reference arrays required' }, 400);
    try { await network.references(parseSessionIdParam(c), body.chatIds, body.projectIds); return c.json({ linked: true }); }
    catch (error) { return c.json({ error: String(error) }, 400); }
  });
  app.post(`${base}/team`, async c => {
    await ready;
    const body = await parseJsonBody<{ members: ChatSpawnInput[]; requestId: string }>(c);
    if (!Array.isArray(body.members) || body.members.length < 1 || body.members.length > 31 || typeof body.requestId !== 'string' || !body.requestId) return c.json({ error: '1–31 members and requestId required' }, 400);
    const created = [];
    try {
      const id = parseSessionIdParam(c);
      await network.validateTeam(id, body.members, body.requestId);
      for (const [index, member] of body.members.entries()) created.push(await network.create(id, member, `${body.requestId}:${index}`, true));
      // Publish work only after the whole team can discover and message its peers.
      for (const [index, member] of body.members.entries()) if (member.start) {
        await network.mailbox.send({ from: rootChatId(id), to: created[index]!.chatId, kind: 'task',
          body: member.prompt?.trim() || member.role, idempotencyKey: `spawn:${body.requestId}:${index}` });
        created[index]!.started = true;
      }
      return c.json({ created });
    } catch (error) { return c.json({ error: String(error), created }, 400); }
  });
  app.post(`${base}/triggers`, async c => {
    await ready;
    const { requestId, ...input } = await parseJsonBody<Pick<ChatTrigger, 'sourceSessionId' | 'targetSessionId' | 'event' | 'prompt' | 'includeFinal'> & { requestId: string }>(c);
    try { return c.json(await network.trigger(parseSessionIdParam(c), input as Pick<ChatTrigger, 'sourceSessionId' | 'targetSessionId' | 'event' | 'prompt' | 'includeFinal'>, requestId ?? '')); }
    catch (error) { return c.json({ error: String(error) }, 400); }
  });
  app.delete(`${base}/triggers/:triggerId`, async c => {
    await ready;
    const trigger = await network.mailbox.files.get<ChatTrigger>('triggers', c.req.param('triggerId'));
    if (!trigger || trigger.ownerSessionId !== parseSessionIdParam(c)) return c.json({ error: 'Trigger not found' }, 404);
    await network.mailbox.files.put('triggers', trigger.id, { ...trigger, status: 'cancelled' });
    return c.json({ cancelled: true });
  });
}

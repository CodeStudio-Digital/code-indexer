/**
 * ChildChatPort for the coder workers, over the app's child-agent host.
 * Every call acts as `callerId` and reaches only its own descendants: a wait
 * for any other chat is refused, a message reaches only a direct child, and a
 * stop goes through the host's ancestor check. A task to a child that is not
 * running (idle, finished or stopped) is its next run, an explicit new start;
 * a task to a queued or running child, a question and a notice go through the
 * mailbox, which the child's run takes in at its next turn boundary.
 */
import { rootChatId, type ChatCollaborationStore } from '@mcp/session-storage/collaboration/store.js';
import type { ChildChatPort } from '@mcp/code-agent/ports/child-chat-port.js';
import type { ServerDeps } from '../../deps.js';
import type { ChildAgentHost } from './child-agent-host.js';

type Sessions = Pick<ServerDeps['sessionStore'], 'getSession' | 'getChildAgentSession' | 'listChildAgentSessions' | 'refreshSession'>;

const lower = (id: unknown) => String(id).toLowerCase();

export function createChildChatPort(host: ChildAgentHost, input: { sessions: Sessions; mailbox: ChatCollaborationStore }): ChildChatPort {
  const { sessions, mailbox } = input;
  const isDescendant = async (callerId: string, chatId: string) => {
    let current = chatId;
    for (let step = 0; step < 16; step++) {
      const child = await sessions.getChildAgentSession(current);
      if (!child) return false;
      if (lower(child.parent_session_id) === lower(callerId)) return true;
      current = child.parent_session_id;
    }
    return false;
  };
  const statusOf = async (chatId: string) => (await host.wait({ chatIds: [chatId], timeoutMs: 0 })).items[0]?.status;

  return {
    async create(callerId, request) {
      const { child, created } = await host.create(callerId, request);
      return { chatId: child.id, title: request.title, profile: child.profile ?? request.profile, readOnly: child.read_only, created };
    },
    async wait(callerId, request, signal) {
      for (const id of request.chatIds) {
        if (!await isDescendant(callerId, id)) throw new Error(`Chat ${id} is not a child chat of this session`);
      }
      return host.wait({ ...request, signal });
    },
    stop: (callerId, chatIds) => host.stop(callerId, chatIds),
    async message(callerId, chatId, message) {
      await sessions.refreshSession(chatId);
      const child = await sessions.getChildAgentSession(chatId);
      if (!child || lower(child.parent_session_id) !== lower(callerId)) return null;
      if (message.kind === 'task' && message.readOnlyTargetsOnly && !child.read_only) {
        throw new Error(`Chat ${chatId} can write; while this session is planning or read-only, tasks go only to read-only child chats`);
      }
      const status = await statusOf(child.id);
      if (message.kind === 'task' && status !== 'queued' && status !== 'running') {
        const entry = await host.service.requestNext(child.id, message.message, { background: message.background });
        if (!entry) throw new Error(`Chat ${chatId} is still finishing its previous run; send the task again in a moment`);
        return { since: entry.requested_at ?? new Date().toISOString() };
      }
      const since = new Date().toISOString();
      const sent = await mailbox.send({ from: rootChatId(callerId), to: rootChatId(child.id), kind: message.kind,
        body: message.message, idempotencyKey: message.key, references: message.references });
      return { since, messageId: sent.id };
    },
    async list(callerId) {
      const children = await sessions.listChildAgentSessions(callerId);
      const { items } = await host.wait({ chatIds: children.map((child) => child.id), timeoutMs: 0 });
      return Promise.all(children.map(async (child, index) => ({
        chatId: child.id, title: (await sessions.getSession(child.id))?.title ?? child.id, profile: child.profile ?? 'explore',
        depth: child.depth, readOnly: child.read_only, status: items[index]?.status ?? 'idle',
        ...(items[index]?.reason ? { reason: items[index]!.reason } : {}),
      })));
    },
  };
}

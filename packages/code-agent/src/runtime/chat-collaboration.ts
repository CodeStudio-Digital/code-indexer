import { ChatCollaborationStore, formatChatMessage, rootChatId, type ChatParticipant } from '@mcp/session-storage/collaboration/store.js';

export interface CollaborationRunner {
  pushUserMessage(text: string): void;
  hasPendingUserMessages(): boolean;
  readonly messages?: Array<{ role: string; content: Array<{ type: string; text?: string }> }>;
}

/** Watch filesystem events across workers. No provider-side inbox polling. */
export async function attachChatMailbox(
  store: ChatCollaborationStore,
  participant: Omit<ChatParticipant, 'updatedAt'>,
  runner: CollaborationRunner,
): Promise<() => Promise<void>> {
  await store.register({ ...participant, state: 'running' });
  let closed = false;
  let chain = Promise.resolve();
  const injected = new Set<string>();
  const inHistory = (id: string) => runner.messages?.some(row => row.role === 'user'
    && row.content.some(block => block.type === 'text' && block.text?.includes('<agent_message>') && block.text.includes(`"messageId":"${id}"`))) === true;
  const deliver = async () => {
    if (closed) return;
    const self = await store.participant(participant.id);
    if (self?.state === 'stopped') return;
    const rows = await store.pending(participant.id);
    for (const message of rows) {
      if (closed || message.to !== participant.id || injected.has(message.id) || ['expired', 'cancelled', 'answered'].includes(message.status)) continue;
      // Delivered messages remain readable. Only unacknowledged deliveries are injected again after recovery.
      if (message.status !== 'queued') continue;
      if (!await store.currentGeneration(message)) continue;
      const sender = await store.participant(message.from);
      if (!sender || !await store.connected(sender.sessionId, participant.sessionId)) continue;
      injected.add(message.id);
      if (inHistory(message.id)) { await store.acknowledge(participant.id, message.id); continue; }
      runner.pushUserMessage(`<agent_message>\n${formatChatMessage(message)}\n</agent_message>`);
      // The content is still retained in the durable inbox if the runner stops before its next provider turn.
    }
  };
  let scheduled = false;
  const schedule = () => {
    if (scheduled || closed) return;
    scheduled = true;
    chain = chain.then(async () => { scheduled = false; await deliver(); })
      .catch(error => console.warn('[chat-collaboration] delivery failed:', error));
  };
  const unsubscribe = store.subscribe(schedule);
  schedule();
  await chain;
  return async () => {
    closed = true; unsubscribe(); await chain;
    for (const id of injected) if (inHistory(id)) await store.acknowledge(participant.id, id);
    const self = await store.participant(participant.id);
    if (self?.state !== 'stopped') await store.register({ ...participant, state: 'idle' });
  };
}

export async function createRootCollaboration(dataDir: string, sessionId: string, label: string) {
  const store = new ChatCollaborationStore(dataDir);
  await store.init();
  const participant = await store.registerRoot(sessionId, label);
  return { store, actor: rootChatId(sessionId), participant };
}

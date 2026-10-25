import type { ChatCompletion, ChatNetworkConfig, ChatTrigger } from '@mcp/session-storage/collaboration/network-types.js';
import { rootChatId } from '@mcp/session-storage/collaboration/store.js';
import type { SessionNetwork } from './session-network.js';

/** One-shot dependency delivery is durable and replay-safe across host restarts. */
export async function deliverNetworkTriggers(network: SessionNetwork): Promise<void> {
  for (const trigger of await network.mailbox.files.list<ChatTrigger>('triggers')) {
    if (trigger.status !== 'waiting') continue;
    try {
    const config = await network.config(trigger.ownerSessionId).catch(() => null);
    if (!config?.enabled) continue;
    const root = await network.config(config.rootId).catch(() => null);
    if (!root?.enabled) continue;
    const completion = await network.mailbox.files.get<ChatCompletion>('completions', trigger.sourceSessionId);
    if (!completion || completion.runId === trigger.baselineRunId || completion.at < trigger.createdAt) continue;
    const success = completion.reason === 'completed';
    if ((trigger.event === 'completed' && !success) || (trigger.event === 'failed' && completion.reason !== 'error')) continue;
    if (!await network.mailbox.connected(trigger.ownerSessionId, trigger.targetSessionId)
      || !await network.mailbox.connected(trigger.ownerSessionId, trigger.sourceSessionId)) continue;
    const result = trigger.includeFinal ? await network.read(trigger.ownerSessionId, trigger.sourceSessionId).catch(() => null) : null;
    await network.mailbox.send({ from: rootChatId(trigger.sourceSessionId), to: rootChatId(trigger.targetSessionId), kind: 'task',
      idempotencyKey: `trigger:${trigger.id}:${completion.runId}`,
      body: JSON.stringify({ trigger: trigger.id, sourceChat: trigger.sourceSessionId, outcome: completion.reason,
        instruction: trigger.prompt, ...(trigger.includeFinal ? { previousFinalAnswer: result?.final ?? null } : {}) }) });
    await network.mailbox.files.put('triggers', trigger.id, { ...trigger, status: 'fired', firedRunId: completion.runId });
    } catch (error) {
      // A deleted peer or temporary delivery failure must not hold up unrelated dependencies/inboxes.
      console.warn(`[session-network] Trigger ${trigger.id} could not be delivered:`, error);
    }
  }
}

export async function reserveNetworkWake(network: SessionNetwork, sessionId: string, messageId: string): Promise<boolean> {
  const config = await network.mailbox.files.get<ChatNetworkConfig>('networks', sessionId);
  if (!config) return true;
  const root = await network.config(config.rootId);
  if (config.rootId !== sessionId && (!config.enabled || !root.enabled)) return false;
  for (let slot = 0; slot < root.maxWakeups; slot++) {
    const reservation = await network.mailbox.files.insert('wake-slots', `${root.rootId}:${root.budgetId}:${slot}`, { messageId, rootId: root.rootId, budgetId: root.budgetId });
    if (reservation.messageId === messageId) return true;
  }
  return false;
}

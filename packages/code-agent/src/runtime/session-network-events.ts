import type { ChatCompletion, ChatNetworkConfig, ChatTrigger } from '@mcp/session-storage/collaboration/network-types.js';
import { rootChatId } from '@mcp/session-storage/collaboration/store.js';
import type { SessionNetwork } from './session-network.js';

/** One-shot dependency delivery is durable and replay-safe across host restarts. */
export async function deliverNetworkTriggers(network: SessionNetwork): Promise<void> {
  for (const trigger of await network.mailbox.files.list<ChatTrigger>('triggers')) {
    if (trigger.status !== 'waiting') continue;
    try {
    if ((trigger.sourceEpoch ?? 0) !== await network.mailbox.epoch(trigger.sourceSessionId)
      || (trigger.targetEpoch ?? 0) !== await network.mailbox.epoch(trigger.targetSessionId)) {
      await network.mailbox.files.put('triggers', trigger.id, { ...trigger, status: 'cancelled' }); continue;
    }
    const config = await network.config(trigger.ownerSessionId).catch(() => null);
    if (!config?.enabled) continue;
    const root = await network.config(config.rootId).catch(() => null);
    if (!root?.enabled) continue;
    const events = await network.mailbox.completions(trigger.sourceSessionId);
    const baseline = trigger.baselineRunId ? events.findIndex(row => row.runId === trigger.baselineRunId) : -1;
    if (trigger.journalCursorVersion === 1 && trigger.baselineRunId && baseline < 0) throw new Error('cursor_expired: trigger baseline is missing');
    const candidates = trigger.journalCursorVersion === 1 ? events.slice(baseline + 1) : events.filter(row => row.at >= trigger.createdAt);
    const completion = candidates.find(row =>
      row.runId !== trigger.baselineRunId
      && (trigger.event === 'finished' || (trigger.event === 'completed' ? row.reason === 'completed'
        : !['completed', 'aborted', 'cancelled'].includes(row.reason))));
    if (!completion) continue;
    if (!await network.mailbox.connected(trigger.ownerSessionId, trigger.targetSessionId)
      || !await network.mailbox.connected(trigger.ownerSessionId, trigger.sourceSessionId)) continue;
    const result = trigger.includeFinal && completion.finalText === undefined && events.at(-1)?.runId === completion.runId
      ? await network.read(trigger.ownerSessionId, trigger.sourceSessionId).catch(() => null) : null;
    await network.mailbox.send({ from: rootChatId(trigger.sourceSessionId), to: rootChatId(trigger.targetSessionId), kind: 'task',
      idempotencyKey: `trigger:${trigger.id}:${completion.runId}`,
      body: JSON.stringify({ trigger: trigger.id, sourceChat: trigger.sourceSessionId, outcome: completion.reason,
        instruction: trigger.prompt, ...(trigger.includeFinal ? { previousFinalAnswer: completion.finalText ?? result?.final ?? null } : {}) }) });
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

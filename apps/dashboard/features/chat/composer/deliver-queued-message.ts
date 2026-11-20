import { apiPost } from '../../../hooks/useApi.js';
import { getAgentSessionSnapshot, readAgentStreamCursor } from '../../../hooks/agent-stream/session-stream-store.js';
import { sessionProviderSwitches } from '../../../hooks/agent-stream/provider-switch.js';
import { MessageNotStartedError, type QueueDeliver } from './message-queue.js';
import { formatCoderTerminalError } from '../terminal-error.js';

export interface MessageReceipt {
  accepted?: boolean;
  busy?: boolean;
  active?: boolean;
  started?: boolean;
  bus_id?: string;
  message_id?: number;
  terminal?: { event: string; data: { reason?: string; message?: string; error?: string; not_started?: boolean } };
}

/** One admission request, one durable command ID, no fallback resend. */
export async function deliverQueuedMessage(options: {
  sessionId: string;
  text: string;
  delivery: Parameters<QueueDeliver>[1];
  settings: Record<string, unknown>;
  reattach: (sessionId: string, onComplete?: () => void, fresh?: boolean) => Promise<void>;
  refresh: () => void;
}): ReturnType<QueueDeliver> {
  const { sessionId, text, delivery, settings, reattach, refresh } = options;
  await sessionProviderSwitches.wait(sessionId);
  const receipt = await apiPost<MessageReceipt>(`/coder/sessions/${sessionId}/messages`, {
    ...settings, content: text, attachments: delivery.attachments, selected_skill_ids: delivery.skillIds,
    interject: delivery.interject, client_msg_id: delivery.clientMessageId,
    response_mode: 'json', only_when_idle: !delivery.interject,
  });
  if (receipt.busy || receipt.active) {
    const fresh = receipt.started === true || !getAgentSessionSnapshot(sessionId).streaming
      || readAgentStreamCursor(sessionId).busId !== receipt.bus_id;
    // Observation cannot change a confirmed delivery back into a failed send.
    // The stream owns reconnect/error reporting; it never posts the message.
    void reattach(sessionId, refresh, fresh).catch(() => undefined);
  }
  if (receipt.busy) return 'busy';
  if (!receipt.accepted) throw new Error('The server did not confirm message delivery');
  if (receipt.terminal) {
    refresh();
    if (receipt.terminal.event === 'error') {
      const data = receipt.terminal.data;
      const message = formatCoderTerminalError(data);
      if (data.not_started === true && ['worker-draining', 'turn-ended-before-input', 'worker-unavailable-before-input'].includes(data.reason ?? '')) {
        throw new MessageNotStartedError(message);
      }
      throw new Error(message);
    }
  }
  return receipt.active && Number.isSafeInteger(receipt.message_id)
    ? { acceptedMessageId: receipt.message_id! } : 'accepted';
}

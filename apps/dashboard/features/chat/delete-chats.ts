import { apiPost } from '../../hooks/useApi.js';
import { forgetAgentSession } from '../../hooks/agent-stream/session-stream-store.js';
import { clearSessionWorkerLog } from '../../hooks/agent-stream/worker-log-store.js';
import { sessionProviderSwitches } from '../../hooks/agent-stream/provider-switch.js';
import { forgetMessageQueue } from './composer/useMessageQueue.js';
import { forgetDraft } from './composer/composer-draft-store.js';
import { usePinnedTabs } from '../../state/pinned-tabs.js';

const pending = new Map<string, Promise<void>>();

/** All chat surfaces share confirmed deletion and renderer cleanup. */
export function deleteChats(ids: string[]): Promise<void> {
  const unique = [...new Set(ids)].sort();
  const key = unique.join(',');
  const previous = pending.get(key);
  if (previous) return previous;
  const operation = (async () => {
    const result = await apiPost<{
      ok: boolean; items: Array<{ session_id: string }>;
      failures?: Array<{ session_id: string; error: string }>;
    }>('/coder/sessions/batch-delete', { ids: unique, permanent: true });
    const deleted = result.items.map(item => item.session_id);
    for (const id of deleted) {
      forgetMessageQueue(id);
      forgetAgentSession(id);
      clearSessionWorkerLog(id);
      sessionProviderSwitches.forget(id);
      forgetDraft(`coder:${id}`);
      const pins = usePinnedTabs.getState();
      for (const pin of pins.pins) {
        if (pin.kind === 'session' && pin.id.endsWith(`:${id}`)) pins.unpin(pin.id);
      }
    }
    window.dispatchEvent(new CustomEvent('coder:sessions-deleted', { detail: { ids: deleted } }));
    window.dispatchEvent(new CustomEvent('coder:sessions-changed'));
    if (!result.ok) throw new Error(result.failures?.map(item => item.error).join('\n') || 'Failed to delete chats');
  })().finally(() => { if (pending.get(key) === operation) pending.delete(key); });
  pending.set(key, operation);
  return operation;
}

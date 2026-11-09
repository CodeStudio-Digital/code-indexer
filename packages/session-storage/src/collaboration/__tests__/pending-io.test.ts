import { setImmediate } from 'node:timers/promises';
import { afterEach, expect, it, vi } from 'vitest';
import { ChatCollaborationStore, type ChatMessage } from '../store.js';

afterEach(() => vi.restoreAllMocks());

function message(id: string, kind: ChatMessage['kind'] = 'task'): ChatMessage {
  return { id, kind, from: 'sender', to: 'recipient', body: id, references: [],
    createdAt: 1, deadlineAt: Date.now() + 60_000, status: 'queued' };
}

it('avoids receipt reads for notifications and answered requests during wake recovery, while preserving inbox notifications', async () => {
  const store = new ChatCollaborationStore('unused-fixture');
  const request = message('answered');
  const response = { ...message('response', 'response'), replyTo: request.id };
  const notifications = Array.from({ length: 505 }, (_, i) => message(`notice-${i}`, 'notify'));
  vi.spyOn(store.files, 'list').mockResolvedValue([request, response, message('waiting'), ...notifications]);
  const reads = vi.spyOn(store.files, 'get').mockResolvedValue(null);

  expect((await store.pending(undefined, { wakeOnly: true })).map(row => row.id)).toEqual(['response', 'waiting']);
  expect(reads).toHaveBeenCalledTimes(4);
  expect((await store.pending()).filter(row => row.kind === 'notify')).toHaveLength(505);
});

it('bounds concurrent receipt IO without truncating old pending work', async () => {
  const store = new ChatCollaborationStore('unused-fixture');
  const messages = Array.from({ length: 100 }, (_, i) => message(`pending-${i}`));
  vi.spyOn(store.files, 'list').mockResolvedValue(messages);
  let inFlight = 0;
  let peak = 0;
  const reads = vi.spyOn(store.files, 'get').mockImplementation(async () => {
    peak = Math.max(peak, ++inFlight);
    await setImmediate();
    inFlight--;
    return null;
  });

  expect(await store.pending(undefined, { wakeOnly: true })).toEqual(messages);
  expect(reads).toHaveBeenCalledTimes(200);
  expect(peak).toBeLessThanOrEqual(32);
  expect(inFlight).toBe(0);
});

it('keeps delivered messages in the inbox without re-waking them and honors cancellation', async () => {
  const store = new ChatCollaborationStore('unused-fixture');
  vi.spyOn(store.files, 'list').mockResolvedValue([message('delivered'), message('cancelled'), message('queued')]);
  vi.spyOn(store.files, 'get').mockImplementation(async (_kind, key) =>
    key === 'delivered:delivered' || key === 'cancelled:cancelled' ? { id: key } as never : null);

  expect((await store.pending(undefined, { wakeOnly: true })).map(row => row.id)).toEqual(['queued']);
  expect((await store.pending()).map(row => [row.id, row.status])).toEqual([['delivered', 'delivered'], ['queued', 'queued']]);
});

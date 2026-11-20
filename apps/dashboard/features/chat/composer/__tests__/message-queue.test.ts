import { describe, expect, it, vi } from 'vitest';
import { MessageNotStartedError, MessageQueue, type QueueDeliver, type QueuedMessage } from '../message-queue.js';

const active = { streaming: true, doneReason: null, error: null };
const completed = { streaming: false, doneReason: 'completed', error: null };
const tick = () => new Promise(resolve => setTimeout(resolve, 0));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
function setup(deliver: QueueDeliver = async () => 'accepted', streaming = true) {
  let id = 0;
  return new MessageQueue({ state: streaming ? active : completed, deliver, newId: () => `message-${++id}` });
}

describe('conversation outbox', () => {
  it('keeps accepted steering visible until its actual runner boundary', async () => {
    const deliver = vi.fn<QueueDeliver>().mockResolvedValue({ acceptedMessageId: 42 });
    const queue = setup(deliver);
    queue.enqueue('guidance', 'next-turn'); await tick();
    expect(queue.getSnapshot().items[0]?.status).toBe('accepted');
    queue.remove('message-1'); queue.promote('message-1'); await tick();
    expect(deliver).toHaveBeenCalledOnce(); expect(queue.getSnapshot().items).toHaveLength(1);
    queue.setRunState({ ...active, consumedMessageIds: [41] });
    expect(queue.getSnapshot().items).toHaveLength(1);
    queue.setRunState({ ...active, consumedMessageIds: [41, 42] });
    expect(queue.getSnapshot().items).toEqual([]);
  });

  it('handles the runner consuming the message before the HTTP acknowledgement', async () => {
    const queue = setup(async () => { queue.setRunState({ ...active, consumedMessageIds: [42] }); return { acceptedMessageId: 42 }; });
    queue.enqueue('guidance', 'next-turn'); await tick();
    expect(queue.getSnapshot().items).toEqual([]);
  });

  it('delivers parked tasks FIFO, one per completed run', async () => {
    const deliver = vi.fn<QueueDeliver>(async () => { queue.setRunState(active); return 'accepted'; });
    const queue = setup(deliver);
    for (const text of ['one', 'two', 'three']) queue.enqueue(text, 'end-of-session');
    await tick();
    expect(deliver).not.toHaveBeenCalled();
    for (const text of ['one', 'two', 'three']) {
      queue.setRunState(completed);
      await tick();
      expect(deliver.mock.lastCall?.[0]).toBe(text);
    }
    expect(deliver).toHaveBeenCalledTimes(3);
    expect(queue.getSnapshot().items).toEqual([]);
  });

  it('serializes sends and retains text, attachments and skills until acknowledged', async () => {
    const ack = deferred<'accepted'>();
    const deliver = vi.fn<QueueDeliver>().mockReturnValueOnce(ack.promise).mockResolvedValue('accepted');
    const queue = setup(deliver);
    const attachments = [{ name: 'screenshot.png', mediaType: 'image/png', base64: 'AAAA' }];
    queue.enqueue('one', 'next-turn', attachments, ['skill']);
    queue.enqueue('two', 'next-turn');
    await tick();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(queue.getSnapshot().items.map(item => item.status)).toEqual(['sending', 'pending']);
    expect(deliver.mock.calls[0]?.[1]).toMatchObject({ clientMessageId: 'message-1', interject: true, attachments, skillIds: ['skill'] });
    queue.remove('message-1');
    expect(queue.getSnapshot().items).toHaveLength(2);
    ack.resolve('accepted');
    await tick();
    expect(deliver.mock.calls.map(call => call[0])).toEqual(['one', 'two']);
    expect(queue.getSnapshot().items).toEqual([]);
  });

  it('preserves a failed send and retries with the same command ID only on request', async () => {
    const deliver = vi.fn<QueueDeliver>().mockRejectedValueOnce(new Error('offline')).mockResolvedValue('accepted');
    const queue = setup(deliver);
    queue.enqueue('one', 'next-turn');
    queue.enqueue('two', 'next-turn');
    await tick();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(queue.getSnapshot()).toMatchObject({ paused: true, items: [{ id: 'message-1', status: 'error', error: 'offline' }, { status: 'pending' }] });
    queue.promote('message-1');
    queue.promote('message-1');
    await tick();
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver.mock.lastCall?.[1].clientMessageId).toBe('message-1');
    expect(queue.getSnapshot().items).toHaveLength(1);
    queue.resume();
    await tick();
    expect(deliver).toHaveBeenCalledTimes(3);
  });

  it('uses a new ID on explicit retry after a confirmed pre-start refusal', async () => {
    const deliver = vi.fn<QueueDeliver>().mockRejectedValueOnce(new MessageNotStartedError('worker draining')).mockResolvedValue('accepted');
    const queue = setup(deliver);
    queue.enqueue('one', 'next-turn');
    await tick();
    expect(deliver).toHaveBeenCalledOnce();
    const [item] = queue.getSnapshot().items;
    expect(item).toMatchObject({ id: 'message-2', status: 'error', text: 'one' });
    queue.promote(item.id);
    await tick();
    expect(deliver.mock.calls.map(call => call[1].clientMessageId)).toEqual(['message-1', 'message-2']);
    expect(queue.getSnapshot().items).toEqual([]);
  });

  it('replays an uncertain parked delivery with its original body and identity', async () => {
    const deliver = vi.fn<QueueDeliver>().mockRejectedValueOnce(new Error('lost response')).mockResolvedValue('accepted');
    const queue = setup(deliver, false);
    queue.enqueue('parked', 'end-of-session');
    await tick();
    queue.promote('message-1');
    queue.promote('message-1');
    await tick();
    expect(deliver.mock.calls).toHaveLength(2);
    expect(deliver.mock.calls[0][1]).toMatchObject({ clientMessageId: 'message-1', interject: false });
    expect(deliver.mock.calls[1]).toEqual(deliver.mock.calls[0]);
    expect(queue.getSnapshot().items).toEqual([]);
  });

  it('promotes one chosen item without flushing the others', async () => {
    const deliver = vi.fn<QueueDeliver>().mockResolvedValue('accepted');
    const queue = setup(deliver);
    queue.enqueue('one', 'end-of-session'); queue.enqueue('two', 'end-of-session'); queue.enqueue('three', 'end-of-session');
    queue.promote('message-2');
    await tick();
    expect(deliver.mock.calls.map(call => call[0])).toEqual(['two']);
    expect(queue.getSnapshot().items.map(item => item.text)).toEqual(['one', 'three']);
    queue.remove('message-1');
    expect(queue.getSnapshot().items.map(item => item.text)).toEqual(['three']);
  });

  it.each([
    { streaming: false, doneReason: 'aborted', error: null },
    { streaming: false, doneReason: 'error', error: 'provider failed' },
    { streaming: false, doneReason: null, error: null },
  ])('does not restart after stop, failure or transport loss: %j', async state => {
    const deliver = vi.fn<QueueDeliver>().mockResolvedValue('accepted');
    const queue = setup(deliver);
    queue.enqueue('parked', 'end-of-session');
    queue.setRunState(state);
    await tick();
    expect(deliver).not.toHaveBeenCalled();
    expect(queue.getSnapshot().paused).toBe(true);
  });

  it('pauses synchronously on Stop before the terminal event and allows explicit steering', async () => {
    const deliver = vi.fn<QueueDeliver>().mockResolvedValue('accepted');
    const queue = setup(deliver);
    queue.enqueue('pending steering', 'next-turn'); queue.enqueue('parked', 'end-of-session');
    queue.pause(); queue.setRunState(completed);
    await tick();
    expect(deliver).not.toHaveBeenCalled();
    queue.promote('message-2');
    await tick();
    expect(deliver.mock.calls.map(call => call[0])).toEqual(['parked']);
  });

  it('keeps conversations independent when their view changes', async () => {
    const deliverA = vi.fn<QueueDeliver>().mockResolvedValue('accepted');
    const deliverB = vi.fn<QueueDeliver>().mockResolvedValue('accepted');
    const a = setup(deliverA); const b = setup(deliverB);
    const detach = a.subscribe(() => undefined);
    a.enqueue('A', 'end-of-session'); b.enqueue('B', 'end-of-session'); detach();
    a.setRunState(completed);
    await tick();
    expect(deliverA).toHaveBeenCalledTimes(1); expect(deliverB).not.toHaveBeenCalled();
    expect(b.getSnapshot().items[0]?.text).toBe('B');
  });

  it('does not dispatch after Stop while the outbox is still being persisted', async () => {
    const saved = deferred<void>(); const deliver = vi.fn<QueueDeliver>().mockResolvedValue('accepted');
    const queue = new MessageQueue({ state: active, deliver, save: () => saved.promise });
    queue.enqueue('not transmitted yet', 'next-turn'); await tick();
    queue.pause(); saved.resolve(); await tick();
    expect(deliver).not.toHaveBeenCalled();
    expect(queue.getSnapshot().items[0]?.status).toBe('pending');
  });

  it('restores attachments and pauses without automatically replaying an uncertain delivery', async () => {
    const deliver = vi.fn<QueueDeliver>().mockResolvedValue('accepted');
    const queue = setup(deliver, false);
    const stored: QueuedMessage[] = [{ id: 'restored', text: 'verify', attachments: [{ name: 'notes.txt', mediaType: 'text/plain', text: 'notes' }], skillIds: ['skill'], mode: 'next-turn', status: 'sending' }];
    await queue.restore(async () => stored);
    await tick();
    expect(deliver).not.toHaveBeenCalled();
    expect(queue.getSnapshot()).toMatchObject({ paused: true, restoring: false, items: [{ status: 'error', attachments: stored[0]!.attachments }] });
    queue.promote('restored'); await tick();
    expect(deliver.mock.lastCall?.[1]).toMatchObject({ clientMessageId: 'restored', attachments: stored[0]!.attachments });
  });

  it('rejects enqueue during restoration without losing the caller draft', async () => {
    const load = deferred<QueuedMessage[]>(); const queue = setup();
    const restoring = queue.restore(() => load.promise);
    expect(queue.enqueue('draft', 'next-turn')).toBe(false);
    load.resolve([]); await restoring;
    expect(queue.enqueue('draft', 'end-of-session')).toBe(true);
  });

  it('retains a deferred task if the server reports an active run', async () => {
    const deliver = vi.fn<QueueDeliver>().mockImplementationOnce(async () => { queue.setRunState(active); return 'busy'; })
      .mockImplementation(async () => { queue.setRunState(active); return 'accepted'; });
    const queue = setup(deliver, false);
    queue.enqueue('later', 'end-of-session'); await tick();
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(queue.getSnapshot().items[0]?.status).toBe('pending');
    queue.setRunState(completed); await tick();
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(deliver.mock.calls[0]![1].clientMessageId).not.toBe(deliver.mock.calls[1]![1].clientMessageId);
  });

  it('cleans queued attachments on deletion even with delivery in flight', async () => {
    const ack = deferred<'accepted'>();
    const saves: QueuedMessage[][] = [];
    const queue = new MessageQueue({ state: active, deliver: () => ack.promise, save: async items => { saves.push(items); } });
    queue.enqueue('one', 'next-turn'); await tick(); queue.dispose(); ack.resolve('accepted'); await tick();
    expect(queue.getSnapshot().items).toEqual([]); expect(saves.at(-1)).toEqual([]);
    expect(queue.enqueue('deleted', 'next-turn')).toBe(false);
  });

  it('makes persistence failure visible without silently discarding messages', async () => {
    const queue = new MessageQueue({ state: active, deliver: async () => 'accepted', save: async () => { throw new Error('quota'); } });
    queue.enqueue('keep me', 'end-of-session'); await tick();
    expect(queue.getSnapshot()).toMatchObject({ storageError: 'queue-storage-unavailable', items: [{ text: 'keep me' }] });
  });
});

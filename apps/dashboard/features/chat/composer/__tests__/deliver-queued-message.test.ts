import { beforeEach, describe, expect, it, vi } from 'vitest';
vi.mock('../../../../hooks/useApi.js', () => ({ apiPost: vi.fn() }));
import { apiPost } from '../../../../hooks/useApi.js';
import { agentStreamLastSeenBusIdMap, updateAgentSession } from '../../../../hooks/agent-stream/session-stream-store.js';
import { deliverQueuedMessage } from '../deliver-queued-message.js';

const post = vi.mocked(apiPost);
beforeEach(() => { post.mockReset(); });
function setup(sessionId = 'delivery-test') {
  return { sessionId, text: 'next task', delivery: { clientMessageId: 'stable-message', interject: true },
    settings: { agent: 'build', max_turns: 20 }, reattach: vi.fn(async () => undefined), refresh: vi.fn() };
}

describe('message admission and stream observation', () => {
  it('never falls back to another POST or opens a stream after an HTTP failure', async () => {
    post.mockRejectedValueOnce(new Error('HTTP 500'));
    const options = setup();
    await expect(deliverQueuedMessage(options)).rejects.toThrow('HTTP 500');
    expect(post).toHaveBeenCalledOnce(); expect(options.reattach).not.toHaveBeenCalled();
  });

  it('retries the identical message ID and preserves attachments and settings', async () => {
    const options = { ...setup(), delivery: { clientMessageId: 'same', interject: false, skillIds: ['skill'], attachments: [{ name: 'a.txt', mediaType: 'text/plain', text: 'a' }] } };
    post.mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ accepted: true, active: true, started: true, bus_id: 'new' });
    await expect(deliverQueuedMessage(options)).rejects.toThrow('offline');
    expect(await deliverQueuedMessage(options)).toBe('accepted');
    expect(post.mock.calls[0]).toEqual(post.mock.calls[1]);
    expect(post.mock.lastCall?.[1]).toMatchObject({ client_msg_id: 'same', response_mode: 'json', only_when_idle: true,
      agent: 'build', attachments: options.delivery.attachments, selected_skill_ids: ['skill'] });
    expect(options.reattach).toHaveBeenCalledWith(options.sessionId, options.refresh, true);
  });

  it('joins the current live observer without replacing it', async () => {
    const options = setup('same-bus');
    updateAgentSession(options.sessionId, { streaming: true });
    agentStreamLastSeenBusIdMap.set(options.sessionId, 'live-bus');
    post.mockResolvedValue({ accepted: true, active: true, bus_id: 'live-bus' });
    expect(await deliverQueuedMessage(options)).toBe('accepted');
    expect(options.reattach).toHaveBeenCalledWith(options.sessionId, options.refresh, false);
  });

  it('returns the persisted message identity for the pending-to-consumed UI transition', async () => {
    post.mockResolvedValue({ accepted: true, active: true, message_id: 42, bus_id: 'live' });
    expect(await deliverQueuedMessage(setup())).toEqual({ acceptedMessageId: 42 });
  });

  it('replaces a stale terminal reader when a new run is acknowledged', async () => {
    const options = setup('new-bus');
    updateAgentSession(options.sessionId, { streaming: false, doneReason: 'completed' });
    agentStreamLastSeenBusIdMap.set(options.sessionId, 'old-bus');
    post.mockResolvedValue({ accepted: true, active: true, bus_id: 'next-bus' });
    expect(await deliverQueuedMessage(options)).toBe('accepted');
    expect(options.reattach).toHaveBeenCalledWith(options.sessionId, options.refresh, true);
  });

  it('retains a parked message when the server is busy and observes that run', async () => {
    const options = setup('busy');
    post.mockResolvedValue({ accepted: false, busy: true, bus_id: 'busy-bus' });
    expect(await deliverQueuedMessage(options)).toBe('busy');
    expect(options.reattach).toHaveBeenCalledOnce();
  });

  it('does not mark a malformed or missing acknowledgement as sent', async () => {
    post.mockResolvedValue({});
    await expect(deliverQueuedMessage(setup())).rejects.toThrow('did not confirm');
  });

  it('reports a failed terminal receipt without repeating the admitted operation', async () => {
    const options = setup();
    post.mockResolvedValue({ accepted: true, terminal: { event: 'error', data: { message: 'provider failed' } } });
    await expect(deliverQueuedMessage(options)).rejects.toThrow('provider failed');
    expect(options.refresh).toHaveBeenCalledOnce(); expect(post).toHaveBeenCalledOnce();
  });
});

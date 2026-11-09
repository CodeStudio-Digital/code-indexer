import { afterEach, describe, expect, it, vi } from 'vitest';
import { deleteChats } from '../delete-chats.js';
import { setDraft, getDraft } from '../composer/composer-draft-store.js';
import { __resetAgentStreamStoreForTests, updateAgentSession, getAgentSessionSnapshot,
  agentStreamAbortMap, agentStreamLastSeenSeqMap } from '../../../hooks/agent-stream/session-stream-store.js';
import { __resetWorkerLogForTests, pushWorkerLog, peekWorkerLog } from '../../../hooks/agent-stream/worker-log-store.js';

const post = vi.hoisted(() => vi.fn());
vi.mock('../../../hooks/useApi.js', () => ({ apiPost: post }));
const id = '11111111-1111-4111-8111-111111111111';
const other = '22222222-2222-4222-8222-222222222222';
afterEach(() => { __resetAgentStreamStoreForTests(); __resetWorkerLogForTests(); vi.unstubAllGlobals(); post.mockReset(); });
function seed() {
  vi.stubGlobal('window', new EventTarget());
  vi.stubGlobal('requestAnimationFrame', () => 1); vi.stubGlobal('cancelAnimationFrame', vi.fn());
  const ctrl = new AbortController(); agentStreamAbortMap.set(id, ctrl);
  agentStreamLastSeenSeqMap.set(id, 42);
  updateAgentSession(id, { streaming: true }); updateAgentSession(other, { streaming: true });
  setDraft(`coder:${id}`, { text: 'private', attachments: [{ name: 'a.png', mediaType: 'image/png', base64: 'AQ==' }] });
  pushWorkerLog(id, { event: 'text', data: 'private output', at: 1 } as any);
  return ctrl;
}
describe('confirmed chat deletion cleanup', () => {
  it('discards only confirmed chats and prevents late composer saves from resurrecting attachments', async () => {
    const ctrl = seed();
    post.mockResolvedValue({ ok: false, items: [{ session_id: id }], failures: [{ session_id: other, error: 'writer busy' }] });
    await expect(deleteChats([id, other])).rejects.toThrow('writer busy');
    expect(ctrl.signal.aborted).toBe(true);
    expect(getAgentSessionSnapshot(id).streaming).toBe(false);
    expect(getAgentSessionSnapshot(other).streaming).toBe(true);
    expect(agentStreamLastSeenSeqMap.has(id)).toBe(false);
    expect(peekWorkerLog(id)).toEqual([]);
    setDraft(`coder:${id}`, { text: 'late save', attachments: [] });
    expect(getDraft(`coder:${id}`)).toEqual({ text: '', attachments: [] });
  });
  it('preserves renderer state when the backend cannot confirm deletion', async () => {
    seed(); post.mockRejectedValue(new Error('offline'));
    await expect(deleteChats([other])).rejects.toThrow('offline');
    expect(getAgentSessionSnapshot(other).streaming).toBe(true);
  });
  it('coalesces duplicate delete clicks into one permanent-delete request', async () => {
    vi.stubGlobal('window', new EventTarget());
    let resolve!: (value: unknown) => void;
    post.mockImplementation(() => new Promise(r => { resolve = r; }));
    const one = deleteChats([id]); const two = deleteChats([id]);
    expect(one).toBe(two);
    expect(post).toHaveBeenCalledWith('/coder/sessions/batch-delete', { ids: [id], permanent: true });
    resolve({ ok: true, items: [] }); await one;
    expect(post).toHaveBeenCalledOnce();
  });
});

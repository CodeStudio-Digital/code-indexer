import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('react', async (original) => ({
  ...await original<typeof import('react')>(),
  useCallback: (fn: unknown) => fn,
  useEffect: () => undefined,
  useRef: (current: unknown) => ({ current }),
}));
vi.mock('../../../lib/surface-visibility.js', () => ({
  useVisibleExternalStore: (_subscribe: unknown, snapshot: () => unknown) => snapshot(),
}));
const { open } = vi.hoisted(() => ({ open: vi.fn(async () => undefined) }));
vi.mock('../openStream.js', () => ({ openStream: open }));

import { useAgentStream } from '../use-agent-stream-runtime.js';

afterEach(() => { vi.unstubAllGlobals(); open.mockClear(); });

describe('provider selection before message dispatch', () => {
  it('rejects a failed switch instead of reporting success', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'Meridian unavailable' }), {
      status: 503, headers: { 'Content-Type': 'application/json' },
    })));
    await expect(useAgentStream('switch-error').switchProvider('meridian', 'gemini-test'))
      .rejects.toThrow('Meridian unavailable');
  });

  it('waits for the selected provider before opening a message stream', async () => {
    let resolve!: (response: Response) => void;
    vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((done) => { resolve = done; })));
    const stream = useAgentStream('switch-pending');
    const change = stream.switchProvider('meridian', 'gemini-test');
    const send = stream.sendMessage('Oi');
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
    expect(open).not.toHaveBeenCalled();
    resolve(new Response(JSON.stringify({ ok: true, provider: 'meridian', model: 'gemini-test' }), {
      headers: { 'Content-Type': 'application/json' },
    }));
    await Promise.all([change, send]);
    expect(open).toHaveBeenCalledTimes(1);
  });

  it('never sends through the old provider after a rejected change, including a second surface', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'not configured' }), {
      status: 400, headers: { 'Content-Type': 'application/json' },
    })));
    await expect(useAgentStream('switch-blocked').switchProvider('meridian', 'gemini-test')).rejects.toThrow();
    await expect(useAgentStream('switch-blocked').sendMessage('Oi')).rejects.toThrow('not configured');
    expect(open).not.toHaveBeenCalled();
  });

  it('rejects an invalid acknowledgement and allows an explicit retry', async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, provider: 'openai', model: 'gpt-test' })))
      .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true, provider: 'meridian', model: 'gemini-test' })));
    vi.stubGlobal('fetch', fetcher);
    const stream = useAgentStream('switch-retry');
    await expect(stream.switchProvider('meridian', 'gemini-test')).rejects.toThrow('did not confirm');
    await stream.switchProvider('meridian', 'gemini-test');
    await stream.sendMessage('Oi');
    expect(open).toHaveBeenCalledTimes(1);
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SshTunnel } from '@mcp/api-bus';
import { startTunnelPolling } from '../tunnel-polling.js';

function visibility() {
  const events = new EventTarget(); let hidden = false;
  return {
    get visibilityState() { return hidden ? 'hidden' as const : 'visible' as const; },
    addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
    hide(value: boolean) { hidden = value; events.dispatchEvent(new Event('visibilitychange')); },
  };
}
let stop: (() => void) | undefined;
beforeEach(() => vi.useFakeTimers());
afterEach(() => { stop?.(); stop = undefined; vi.useRealTimers(); });

describe('tunnel observer lifetime', () => {
  it.each([true, false])('does not update or recreate a timer after unmount (recurring=%s)', async poll => {
    let finish!: (list: SshTunnel[]) => void;
    const load = vi.fn(() => new Promise<SshTunnel[]>(resolve => { finish = resolve; }));
    const update = vi.fn(), doc = visibility();
    stop = startTunnelPolling(load, update, poll, doc);
    await vi.advanceTimersByTimeAsync(1500); expect(load).toHaveBeenCalledOnce();
    stop(); finish([]); await vi.advanceTimersByTimeAsync(30_000);
    expect(update).not.toHaveBeenCalled(); expect(load).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('adapts to idle counters and owns no timer while hidden', async () => {
    const tunnels = [{ id: 'a', bytesUp: 1, bytesDown: 1 }] as SshTunnel[];
    const load = vi.fn(async () => tunnels), update = vi.fn(), doc = visibility();
    stop = startTunnelPolling(load, update, true, doc);
    await vi.advanceTimersByTimeAsync(3000); expect(load).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(4999); expect(load).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1); expect(load).toHaveBeenCalledTimes(3);
    doc.hide(true); expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(30_000); expect(load).toHaveBeenCalledTimes(3);
    doc.hide(false); await vi.advanceTimersByTimeAsync(5000); expect(load).toHaveBeenCalledTimes(4);
  });
});

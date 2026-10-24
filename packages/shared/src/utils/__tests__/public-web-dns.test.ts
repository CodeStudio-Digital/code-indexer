import { beforeEach, describe, expect, it, vi } from 'vitest';
const dns = vi.hoisted(() => ({ v4: vi.fn(), v6: vi.fn(), cancel: vi.fn() }));
vi.mock('node:dns/promises', () => ({ Resolver: class {
  resolve4 = dns.v4; resolve6 = dns.v6; cancel = dns.cancel;
} }));
import { resolvePublicWebHost } from '../public-web-dns.js';

beforeEach(() => { vi.clearAllMocks(); dns.v4.mockResolvedValue(['93.184.216.34']); dns.v6.mockResolvedValue([]); });
describe('public DNS ownership', () => {
  it('pins one validated address instead of resolving again at socket dispatch', async () => {
    expect(await resolvePublicWebHost('example.com', new AbortController().signal)).toEqual({ address: '93.184.216.34', family: 4 });
    expect(dns.v4).toHaveBeenCalledTimes(1); expect(dns.cancel).toHaveBeenCalled();
  });
  it.each(['127.0.0.1', '10.1.2.3', '::ffff:7f00:1', '100.64.0.1', 'fe80::1'])('rejects mixed DNS answers containing %s', async address => {
    dns.v6.mockResolvedValue([address]);
    await expect(resolvePublicWebHost('public.example', new AbortController().signal)).rejects.toThrow('private or mixed');
  });
  it('cancels outstanding queries and drains them before rejecting', async () => {
    const ctrl = new AbortController(); let reject4!: (e: Error) => void, reject6!: (e: Error) => void;
    dns.v4.mockImplementation(() => new Promise((_, reject) => { reject4 = reject; }));
    dns.v6.mockImplementation(() => new Promise((_, reject) => { reject6 = reject; }));
    dns.cancel.mockImplementation(() => { reject4?.(new Error('cancelled')); reject6?.(new Error('cancelled')); });
    const result = resolvePublicWebHost('pending.example', ctrl.signal); ctrl.abort(new Error('owner stopped'));
    await expect(result).rejects.toThrow('owner stopped'); expect(dns.cancel).toHaveBeenCalled();
  });
  it('never resolves blocked literals or dispatches after a pre-aborted signal', async () => {
    await expect(resolvePublicWebHost('localhost.', new AbortController().signal)).rejects.toThrow('private');
    const ctrl = new AbortController(); ctrl.abort(new Error('stopped'));
    await expect(resolvePublicWebHost('example.com', ctrl.signal)).rejects.toThrow('stopped'); expect(dns.v4).not.toHaveBeenCalled();
  });
});

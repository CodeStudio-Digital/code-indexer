import type { Browser, BrowserContext } from 'playwright-core';
import { describe, expect, it, vi } from 'vitest';
import { ResearchBrowserService } from '../service.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
function context() {
  const page = { goto: vi.fn(async (): Promise<void> => undefined), waitForLoadState: vi.fn(async () => undefined),
    url: () => 'https://example.com/', title: vi.fn(async () => 'Fixture'), on: vi.fn(), locator: vi.fn() };
  const raw = { clearPermissions: vi.fn(async () => undefined), route: vi.fn(async () => undefined),
    routeWebSocket: vi.fn(async () => undefined), newPage: vi.fn(async () => page),
    close: vi.fn(async (): Promise<void> => undefined), on: vi.fn() };
  return { raw, page, value: raw as unknown as BrowserContext };
}
function fixture() {
  const contexts: ReturnType<typeof context>[] = [];
  const raw = { isConnected: () => true, once: vi.fn(), newContext: vi.fn(async () => {
    const created = context(); contexts.push(created); return created.value;
  }) };
  const browser = raw as unknown as Browser;
  const connect = vi.fn(async () => browser);
  const resolveHost = vi.fn(async () => ['93.184.216.34']);
  return { raw, browser, contexts, connect, resolveHost,
    service: new ResearchBrowserService(connect, resolveHost) };
}
const open = (key = 'one', requestId = key) => ({ key, requestId, method: 'open' as const, args: { url: 'https://example.com/' } });
async function until(check: () => boolean) { await vi.waitFor(() => expect(check()).toBe(true)); }

describe('research browser operation ownership', () => {
  it('fences a native context from other owners and legacy prefix cleanup', async () => {
    const f = fixture(), key = 'coder-s-attempt-a', owner = {};
    const scope = { owner, assertDispatch: () => {}, signal: new AbortController().signal };
    await expect(f.service.invoke(open(key))).rejects.toThrow('host owner');
    await f.service.invoke(open(key), scope);
    await expect(f.service.invoke(open(key), { ...scope, owner: {} })).rejects.toThrow('host owner');
    await expect(f.service.invoke({ key: 'coder-s', method: 'closePrefix' })).rejects.toThrow('legacy prefix');
    await expect(f.service.closeOwnedScope(key, {})).rejects.toThrow('another host owner');
    expect(f.contexts[0].raw.close).not.toHaveBeenCalled();
    await f.service.closeOwnedScope(key, owner);
    expect(f.contexts[0].raw.close).toHaveBeenCalledTimes(1);
  });

  it('rechecks authority after connection wait and before creating the context', async () => {
    const f = fixture(), connection = deferred<Browser>(); let valid = true;
    f.connect.mockReturnValueOnce(connection.promise);
    const pending = f.service.invoke(open(), { signal: new AbortController().signal,
      assertDispatch: () => { if (!valid) throw new Error('revoked'); } });
    const rejected = expect(pending).rejects.toThrow('revoked');
    await until(() => f.connect.mock.calls.length === 1);
    valid = false; connection.resolve(f.browser); await rejected;
    expect(f.raw.newContext).not.toHaveBeenCalled();
  });

  it('guards autonomous traffic with attempt lifetime independently of the opening tool deadline', async () => {
    const f = fixture(); let dispatchValid = true, lifetimeValid = true;
    await f.service.invoke(open(), { signal: new AbortController().signal,
      assertDispatch: () => { if (!dispatchValid) throw new Error('tool expired'); },
      assertLifetime: () => { if (!lifetimeValid) throw new Error('attempt revoked'); } });
    const route = { request: () => ({ method: () => 'GET', url: () => 'https://example.com/asset' }),
      continue: vi.fn(async () => undefined), abort: vi.fn(async () => undefined) };
    const callback = (f.contexts[0].raw.route.mock.calls as any[])[0][1];
    dispatchValid = false;
    await callback(route); expect(route.continue).toHaveBeenCalledTimes(1);
    lifetimeValid = false;
    await callback(route); expect(route.continue).toHaveBeenCalledTimes(1);
    expect(route.abort).toHaveBeenCalledTimes(1);
    await f.service.closeAll();
  });

  it('rechecks fill authority after the asynchronous sensitive-field inspection', async () => {
    const f = fixture(); await f.service.invoke(open());
    const inspection = deferred<boolean>(); let valid = true;
    const handle = { evaluate: vi.fn(async () => ({ role: 'textbox', name: 'Search' })),
      dispose: vi.fn(async () => undefined), fill: vi.fn() };
    f.contexts[0].page.locator.mockReturnValue({ count: async () => 1, nth: () => ({ elementHandle: async () => handle }) });
    await f.service.invoke({ key: 'one', method: 'snapshot' });
    handle.evaluate.mockImplementationOnce(() => inspection.promise as any);
    const pending = f.service.invoke({ key: 'one', method: 'fill', args: { ref: 'a1', value: 'query' } },
      { signal: new AbortController().signal, assertDispatch: () => { if (!valid) throw new Error('revoked'); } });
    const rejected = expect(pending).rejects.toThrow('revoked');
    await until(() => handle.evaluate.mock.calls.length === 2);
    valid = false; inspection.resolve(false); await rejected;
    expect(handle.fill).not.toHaveBeenCalled(); await f.service.closeAll();
  });

  it('waits for all contexts even when one cleanup fails', async () => {
    const f = fixture(), delayed = deferred<void>();
    await f.service.invoke(open('one')); await f.service.invoke(open('two'));
    f.contexts[0].raw.close.mockRejectedValueOnce(new Error('first close failed'));
    f.contexts[1].raw.close.mockReturnValueOnce(delayed.promise);
    let settled = false;
    const closing = f.service.closeAll();
    const rejected = expect(closing).rejects.toThrow('cleanup is unconfirmed');
    void closing.finally(() => { settled = true; }).catch(() => undefined);
    await until(() => f.contexts[1].raw.close.mock.calls.length === 1);
    expect(settled).toBe(false); delayed.resolve(); await rejected;
    await f.service.closeAll();
    expect(f.contexts[0].raw.close).toHaveBeenCalledTimes(2);
  });

  it('cancels before DNS finishes without creating a late context', async () => {
    const f = fixture(), dns = deferred<string[]>();
    f.resolveHost.mockReturnValueOnce(dns.promise);
    const invocation = f.service.invoke(open());
    const rejected = expect(invocation).rejects.toThrow(/aborted/);
    await until(() => f.resolveHost.mock.calls.length === 1);
    const cancelled = f.service.cancel('one');
    dns.resolve(['93.184.216.34']);
    await rejected; await cancelled;
    expect(f.connect).not.toHaveBeenCalled();
  });

  it('closes a context delivered after cancellation before creating a page', async () => {
    const f = fixture(), creation = deferred<BrowserContext>(), late = context();
    f.raw.newContext.mockReturnValueOnce(creation.promise);
    const invocation = f.service.invoke(open());
    const rejected = expect(invocation).rejects.toThrow(/aborted/);
    await until(() => f.raw.newContext.mock.calls.length === 1);
    const cancelled = f.service.cancel('one');
    creation.resolve(late.value);
    await rejected; await cancelled;
    expect(late.raw.close).toHaveBeenCalledTimes(1);
    expect(late.raw.newPage).not.toHaveBeenCalled();
    await expect(f.service.invoke({ key: 'one', method: 'extract' })).rejects.toThrow('No research browser');
  });

  it('fences pending connections during closeAll', async () => {
    const f = fixture(), connection = deferred<Browser>();
    f.connect.mockReturnValueOnce(connection.promise);
    const invocation = f.service.invoke(open());
    const rejected = expect(invocation).rejects.toThrow(/closed/);
    await until(() => f.connect.mock.calls.length === 1);
    const closed = f.service.closeAll();
    await expect(f.service.invoke(open('other'))).rejects.toThrow('closing');
    connection.resolve(f.browser);
    await rejected; await closed;
    expect(f.raw.newContext).not.toHaveBeenCalled();
  });

  it('shares a pending connection while keeping contexts isolated', async () => {
    const f = fixture(), connection = deferred<Browser>();
    f.connect.mockReturnValueOnce(connection.promise);
    const first = f.service.invoke(open('one')), second = f.service.invoke(open('two'));
    await until(() => f.resolveHost.mock.calls.length === 2);
    connection.resolve(f.browser);
    await Promise.all([first, second]);
    expect(f.connect).toHaveBeenCalledTimes(1);
    expect(f.contexts).toHaveLength(2);
    await f.service.closeAll();
    for (const created of f.contexts) expect(created.raw.close).toHaveBeenCalledTimes(1);
  });

  it('cancels a queued command without closing the active page', async () => {
    const f = fixture(), created = context(), navigation = deferred<void>();
    f.raw.newContext.mockResolvedValueOnce(created.value);
    created.page.goto.mockReturnValueOnce(navigation.promise);
    const first = f.service.invoke(open('one', 'first'));
    await until(() => created.page.goto.mock.calls.length === 1);
    const queued = f.service.invoke(open('one', 'queued'));
    const rejected = expect(queued).rejects.toThrow(/aborted/);
    const cancelled = f.service.cancel('queued');
    expect(created.raw.close).not.toHaveBeenCalled();
    navigation.resolve(); await first; await rejected; await cancelled;
    expect(created.page.goto).toHaveBeenCalledTimes(1);
    expect(created.raw.close).not.toHaveBeenCalled();
    await f.service.closeAll();
  });

  it('serializes opening one key and permits independent pages to proceed', async () => {
    const f = fixture(), created = context(), navigation = deferred<void>();
    f.raw.newContext.mockResolvedValueOnce(created.value);
    created.page.goto.mockReturnValueOnce(navigation.promise);
    const first = f.service.invoke(open('one', 'first'));
    await until(() => created.page.goto.mock.calls.length === 1);
    const next = f.service.invoke(open('one', 'next'));
    await f.service.invoke(open('other'));
    expect(created.page.goto).toHaveBeenCalledTimes(1);
    navigation.resolve(); await first; await next;
    expect(created.page.goto).toHaveBeenCalledTimes(2);
    expect(f.raw.newContext).toHaveBeenCalledTimes(2);
    await f.service.closeAll();
  });

  it('does not let a late cancelled open replace the next session', async () => {
    const f = fixture(), creation = deferred<BrowserContext>(), late = context();
    f.raw.newContext.mockReturnValueOnce(creation.promise);
    const first = f.service.invoke(open('one', 'first'));
    const rejected = expect(first).rejects.toThrow(/closed/);
    await until(() => f.raw.newContext.mock.calls.length === 1);
    const closed = f.service.invoke({ key: 'one', method: 'close' });
    const next = f.service.invoke(open('one', 'next'));
    creation.resolve(late.value);
    await rejected; await closed; await next;
    expect(late.raw.newPage).not.toHaveBeenCalled();
    expect(late.raw.close).toHaveBeenCalledTimes(1);
    expect(f.contexts).toHaveLength(1);
    expect(f.contexts[0].raw.close).not.toHaveBeenCalled();
    await f.service.closeAll();
  });

  it('retains cleanup failures and permits an explicit close retry', async () => {
    const f = fixture(); await f.service.invoke(open());
    f.contexts[0].raw.close.mockRejectedValueOnce(new Error('close ACK lost'));
    await expect(f.service.invoke({ key: 'one', method: 'close' })).rejects.toThrow('ACK lost');
    await expect(f.service.invoke(open('one', 'next'))).rejects.toThrow('cleanup is unconfirmed');
    expect(f.raw.newContext).toHaveBeenCalledTimes(1);
    await f.service.invoke({ key: 'one', method: 'close' });
    await f.service.invoke(open('one', 'retry'));
    expect(f.raw.newContext).toHaveBeenCalledTimes(2);
    await f.service.closeAll();
  });

  it('closes contexts when setup fails before publishing a session', async () => {
    const f = fixture(), created = context();
    created.raw.route.mockRejectedValueOnce(new Error('setup failed'));
    f.raw.newContext.mockResolvedValueOnce(created.value);
    await expect(f.service.invoke(open())).rejects.toThrow('setup failed');
    expect(created.raw.close).toHaveBeenCalledTimes(1);
    await f.service.invoke(open()); await f.service.closeAll();
  });

  it('rejects duplicate in-flight IDs without replacing cancellation ownership', async () => {
    const f = fixture(), dns = deferred<string[]>();
    f.resolveHost.mockReturnValueOnce(dns.promise);
    const first = f.service.invoke(open('one', 'same'));
    const rejected = expect(first).rejects.toThrow(/aborted/);
    await until(() => f.resolveHost.mock.calls.length === 1);
    await expect(f.service.invoke(open('two', 'same'))).rejects.toThrow('Duplicate');
    const cancelled = f.service.cancel('same'); dns.resolve(['93.184.216.34']);
    await rejected; await cancelled;
    expect(f.raw.newContext).not.toHaveBeenCalled();
  });

  it('allocates handles only for the requested window and disposes rejected nodes', async () => {
    const f = fixture(); await f.service.invoke(open());
    const skipped = { evaluate: vi.fn(async () => null), dispose: vi.fn(async () => undefined) };
    const retained = { evaluate: vi.fn(async () => ({ role: 'link', name: 'Fixture' })), dispose: vi.fn(async () => undefined) };
    const candidates = { count: vi.fn(async () => 10_000), nth: vi.fn((index: number) => ({
      elementHandle: async () => index === 0 ? skipped : retained,
    })) };
    f.contexts[0].page.locator.mockReturnValue(candidates);
    const result = await f.service.invoke({ key: 'one', method: 'snapshot', args: { limit: 2 } });
    expect(result).toMatchObject({ totalCandidates: 10_000, truncated: true, nodes: [{ ref: 'a1', name: 'Fixture' }] });
    expect(candidates.nth.mock.calls).toEqual([[0], [1]]);
    expect(skipped.dispose).toHaveBeenCalledTimes(1);
    expect(retained.dispose).not.toHaveBeenCalled();
    await f.service.closeAll();
    expect(retained.dispose).toHaveBeenCalledTimes(1);
  });

  it('limits body text before returning it over the browser transport', async () => {
    const f = fixture(); await f.service.invoke(open());
    const evaluate = vi.fn(async (fn: (body: { innerText: string }, maximum: number) => unknown, maximum: number) =>
      fn({ innerText: 'x'.repeat(2_000_000) }, maximum));
    f.contexts[0].page.locator.mockReturnValue({ evaluate });
    const result = await f.service.invoke({ key: 'one', method: 'extract', args: { maxChars: 1_000 } });
    expect(result).toMatchObject({ sourceChars: 2_000_000, truncated: true, text: 'x'.repeat(1_000) });
    expect(evaluate).toHaveBeenCalledTimes(1);
    await f.service.closeAll();
  });
});

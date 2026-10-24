import { expect, it, vi } from 'vitest';
import { NativeBrowserAttempt } from '../native-browser-attempt.js';

function fixture() {
  const controller = new AbortController();
  const backend = { authorityAttested: true as const, invoke: vi.fn(async (_request: unknown, _scope: any) => ({})),
    cancel: vi.fn(async () => undefined), closeOwnedScope: vi.fn(async (_key: string, _owner: object) => undefined) };
  const assertLifetime = vi.fn();
  return { controller, backend, assertLifetime,
    attempt: new NativeBrowserAttempt(backend, 'coder-s-attempt-a', controller.signal, assertLifetime) };
}
it('aborts active dispatch and drains only its own anonymous context', async () => {
  const f = fixture();
  try {
    await f.attempt.invoke({ key: f.attempt.key, method: 'open' }, () => {}, new AbortController().signal);
    const scope = f.backend.invoke.mock.calls[0][1];
    f.controller.abort(); await f.attempt.close();
    expect(scope.signal.aborted).toBe(true);
    expect(f.backend.closeOwnedScope).toHaveBeenCalledExactlyOnceWith(f.attempt.key, scope.owner);
    await expect(f.attempt.invoke({ key: f.attempt.key, method: 'click' }, () => {}, new AbortController().signal))
      .rejects.toThrow('attempt closed');
    expect(f.backend.invoke).toHaveBeenCalledTimes(1);
  } finally { await f.attempt.close(); }
});
it('reclaims its context on lease loss even between tool calls', async () => {
  vi.useFakeTimers(); const f = fixture();
  try {
    f.assertLifetime.mockImplementation(() => { throw new Error('revoked'); });
    await vi.advanceTimersByTimeAsync(101);
    await f.attempt.close(); expect(f.backend.closeOwnedScope).toHaveBeenCalledTimes(1);
  } finally { await f.attempt.close(); vi.useRealTimers(); }
});
it('does not acknowledge unconfirmed cleanup or retry an effect after it', async () => {
  const f = fixture(); f.backend.closeOwnedScope.mockRejectedValueOnce(new Error('context close failed'));
  await expect(f.attempt.close()).rejects.toThrow('context close failed');
  await expect(f.attempt.close()).rejects.toThrow('context close failed');
  expect(f.backend.closeOwnedScope).toHaveBeenCalledTimes(1);
  await expect(f.attempt.invoke({ key: f.attempt.key, method: 'click' }, () => {}, new AbortController().signal))
    .rejects.toThrow('attempt closed');
});

import { afterEach, expect, it, vi } from 'vitest';
import { NativeAuthorityRenewal } from '../workers/native-authority-renewal.js';

afterEach(() => vi.useRealTimers());
function fixture() {
  vi.useFakeTimers(); vi.setSystemTime(1_000);
  const lost = vi.fn();
  const read = vi.fn(async () => 4_000);
  const monitor = new NativeAuthorityRenewal({ attemptId: 'attempt', initialExpiresAtUnixMs: 2_000,
    hardDeadlineAtUnixMs: 5_000, readExpiresAtUnixMs: read, lost });
  return { monitor, read, lost };
}

it('requires the physical ACK before extending Host authority and clamps to the sealed maximum', async () => {
  const { monitor, read, lost } = fixture();
  const renew = vi.fn(async (_request: import('../../../packages/agent-runtime-host/src/driver/HostLifecycleTypes.js').HostAuthorityRenewalRequest) => true);
  monitor.activate(renew);
  await vi.advanceTimersByTimeAsync(1_500);
  expect(lost).not.toHaveBeenCalled();
  expect(renew).toHaveBeenCalledTimes(1);
  expect(renew.mock.calls[0]).toEqual([{ leaseExpiresAtUnixMs: 4_000n, updatedAtUnixMs: 1_000n, idempotencyKey: 'native-renew:attempt:4000' }]);
  read.mockResolvedValue(10_000);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(renew.mock.calls.at(-1)?.[0]).toMatchObject({ leaseExpiresAtUnixMs: 5_000n });
  await vi.advanceTimersByTimeAsync(1_500);
  expect(lost).toHaveBeenCalledTimes(1);
  await monitor.close();
});

it('expires before activation or a late renewal ACK and never revives', async () => {
  const { monitor, lost } = fixture();
  let acknowledge!: (value: boolean) => void;
  const renew = vi.fn(() => new Promise<boolean>(resolve => { acknowledge = resolve; }));
  monitor.activate(renew);
  await vi.advanceTimersByTimeAsync(1_000);
  expect(lost).toHaveBeenCalledTimes(1);
  acknowledge(true);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(lost).toHaveBeenCalledTimes(1);
  expect(renew).toHaveBeenCalledTimes(1);
  await monitor.close();
});

it.each(['regressed', 'revoked', 'ack_failed'] as const)('fences both gateways when authority is %s', async kind => {
  const { monitor, read, lost } = fixture();
  if (kind === 'regressed') read.mockResolvedValue(1_900);
  if (kind === 'revoked') read.mockRejectedValue(new Error('fenced'));
  monitor.activate(async () => { if (kind === 'ack_failed') throw new Error('ACK lost'); return true; });
  await vi.advanceTimersByTimeAsync(1);
  expect(lost).toHaveBeenCalledTimes(1);
  await monitor.close();
});

it('keeps preparation fenced and stops polling when the physical attempt is closing', async () => {
  const first = fixture();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(first.lost).toHaveBeenCalledTimes(1);
  await first.monitor.close();
  const second = fixture();
  second.monitor.activate(async () => false);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(second.lost).not.toHaveBeenCalled();
  expect(second.read).toHaveBeenCalledTimes(1);
  await second.monitor.close();
});

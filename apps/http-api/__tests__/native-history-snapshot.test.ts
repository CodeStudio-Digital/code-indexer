import { create } from '@bufbuild/protobuf';
import { expect, it, vi } from 'vitest';
import { agentV1SessionStore as wire } from '@mcp/agent-runtime-contracts';
import { NativeSessionStoreRequestError } from '@mcp/agent-runtime-host';
import { readNativeHistorySnapshot } from '../native-history-snapshot.js';

const changed = () => new NativeSessionStoreRequestError(create(wire.SessionStoreFailureSchema, {
  code: wire.SessionStoreFailureCode.CONCURRENT_MUTATION, reasonCode: 'concurrent_session_mutation',
}));
const reader = () => ({ assertCurrent: vi.fn(async () => {}), close: vi.fn(async () => {}) });

it('discards a projection invalidated by a concurrent append and keeps only the verified reader', async () => {
  const first = reader(); const second = reader();
  first.assertCurrent.mockRejectedValueOnce(changed());
  const open = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
  const project = vi.fn().mockResolvedValueOnce(['partial']).mockResolvedValueOnce(['committed']);
  const result = await readNativeHistorySnapshot(open, project);
  expect(result).toEqual({ reader: second, value: ['committed'] });
  expect(first.close).toHaveBeenCalledOnce();
  expect(second.close).not.toHaveBeenCalled();
});

it('retries invalidation during open but bounds persistent writer contention', async () => {
  const error = changed();
  const open = vi.fn().mockRejectedValue(error);
  const project = vi.fn();
  await expect(readNativeHistorySnapshot(open, project)).rejects.toBe(error);
  expect(open).toHaveBeenCalledTimes(3);
  expect(project).not.toHaveBeenCalled();
});

it('closes every discarded reader when replay is invalidated repeatedly', async () => {
  const readers = [reader(), reader(), reader()];
  let index = 0;
  const error = changed();
  await expect(readNativeHistorySnapshot(async () => readers[index++]!, async () => { throw error; })).rejects.toBe(error);
  expect(index).toBe(3);
  for (const value of readers) expect(value.close).toHaveBeenCalledOnce();
});

it.each([
  create(wire.SessionStoreFailureSchema, { code: wire.SessionStoreFailureCode.CORRUPT_BUNDLE, reasonCode: 'session_bundle_corrupt' }),
  create(wire.SessionStoreFailureSchema, { code: wire.SessionStoreFailureCode.STALE_AUTHORITY, reasonCode: 'stale_authority' }),
])('propagates authority and integrity failures without reopening', async failure => {
  const current = reader();
  const open = vi.fn(async () => current);
  const error = new NativeSessionStoreRequestError(failure);
  await expect(readNativeHistorySnapshot(open, async () => { throw error; })).rejects.toBe(error);
  expect(open).toHaveBeenCalledOnce();
  expect(current.close).toHaveBeenCalledOnce();
});

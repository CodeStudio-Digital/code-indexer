import { expect, it, vi } from 'vitest';
import { agentV1Runtime } from '@mcp/agent-runtime-contracts';
import { RustHostActiveAttemptController } from '../driver/RustHostActiveAttemptController.js';
import { nextCommittedManagementFact } from '../driver/RustHostManagementFactSequence.js';
import type { AuthenticatedAttemptLifecyclePort, RustHostManagementFactPort } from '../driver/RustHostAttemptCoordinatorTypes.js';
import type { ActiveAttemptAuthoritySnapshot } from '../driver/HostLifecycleTypes.js';
import type { ActiveAttemptAuthorityHandle } from '../driver/HostLifecycleReceipts.js';

it('cancels Control immediately while serializing management Cancel after a pending renewal', async () => {
  const signal = new AbortController();
  const handle = {} as ActiveAttemptAuthorityHandle;
  let acknowledge!: () => void;
  const managementRenewal = new Promise<void>(resolve => { acknowledge = resolve; });
  const managementCancel = vi.fn(async () => {});
  const controlCancel = vi.fn(async () => { signal.abort(); });
  const fail = vi.fn();
  const lifecycle = { inspectActive: () => ({ signal: signal.signal } as ActiveAttemptAuthoritySnapshot),
    cancel: controlCancel, isFailed: false } as unknown as AuthenticatedAttemptLifecyclePort;
  const controller = new RustHostActiveAttemptController(lifecycle, fail);
  controller.startFactPump({ processNext: () => new Promise(() => {}), renewAuthority: () => managementRenewal,
    cancel: managementCancel, fence: async () => {}, reap: async () => {}, abort() {} });
  const renewal = controller.renewAuthority(handle, { leaseExpiresAtUnixMs: 10_000n, updatedAtUnixMs: 1n, idempotencyKey: 'renewal' });
  const cancel = controller.cancel(handle, { reason: agentV1Runtime.CancelReason.USER_REQUEST, reasonCode: 'user',
    graceDeadlineAtUnixMs: 2_000n, idempotencyKey: 'cancel' });
  await Promise.resolve();
  expect(controlCancel).toHaveBeenCalledOnce();
  expect(managementCancel).not.toHaveBeenCalled();
  acknowledge();
  await Promise.all([renewal, cancel]);
  expect(managementCancel).toHaveBeenCalledOnce();
  expect(fail).not.toHaveBeenCalled();
});

it('allows more than 64 authenticated renewal acknowledgements while awaiting physical exit', async () => {
  let count = 0;
  const facts: RustHostManagementFactPort = { processNext: async () => ++count <= 100
    ? { kind: 'command_acknowledged', commandCase: 'updateAttemptAuthority', messageId: 'ack:' + count }
    : { kind: 'committed', factCase: 'attemptProcessExited', messageId: 'exit' },
  cancel: async () => {}, fence: async () => {}, reap: async () => {}, abort() {} };
  expect(await nextCommittedManagementFact(facts, ['attemptProcessExited'], new AbortController().signal))
    .toMatchObject({ factCase: 'attemptProcessExited' });
  expect(count).toBe(101);
});

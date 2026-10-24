import { create } from '@bufbuild/protobuf';
import { expect, it, vi } from 'vitest';
import { agentV1Common, agentV1SessionStore as journal } from '@mcp/agent-runtime-contracts';
import { withNativeTerminalCommitBarrier } from '../native/NativeTerminalCommitBarrier.js';
import type { DurableEngineEventCommitRequest } from '../ipc/DurableEngineEventCommitPort.js';

function request(): DurableEngineEventCommitRequest {
  return { identity: create(agentV1Common.AttemptIdentitySchema, { attemptId: 'attempt' }), runtimeInstanceId: 'runtime',
    expectedPayloadSha256: new Uint8Array(32).fill(1), record: create(journal.EngineEventRecordV1Schema, { localSequence: 10n,
      body: { case: 'terminal', value: { classification: journal.EngineTerminalClassificationV1.COMPLETED } } }) };
}
it('waits for child settlement before durable commit and shares replay settlement', async () => {
  let finish!: () => void;
  const settle = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const commit = vi.fn(async () => create(journal.CommitSessionRecordReceiptSchema));
  const port = withNativeTerminalCommitBarrier({ commit }, settle);
  const first = port.commit(request()), replay = port.commit(request());
  await Promise.resolve(); expect(commit).not.toHaveBeenCalled(); expect(settle).toHaveBeenCalledOnce();
  finish(); await Promise.all([first, replay]); expect(commit).toHaveBeenCalledTimes(2);
  await port.commit(request()); expect(settle).toHaveBeenCalledOnce();
});
it('never commits or repeats a failed settlement and rejects divergent terminal replay', async () => {
  const commit = vi.fn(), settle = vi.fn(async () => { throw new Error('uncertain child'); });
  const port = withNativeTerminalCommitBarrier({ commit }, settle);
  await expect(port.commit(request())).rejects.toThrow('uncertain child');
  await expect(port.commit(request())).rejects.toThrow('uncertain child');
  const different = request(); different.expectedPayloadSha256[0] = 2;
  await expect(port.commit(different)).rejects.toThrow('replay diverged');
  expect(commit).not.toHaveBeenCalled(); expect(settle).toHaveBeenCalledOnce();
});
it('passes nonterminal commits, frontiers and acknowledgements through with their receiver', async () => {
  const original = { commit: vi.fn(async () => create(journal.CommitSessionRecordReceiptSchema)),
    commitProviderFrontier: vi.fn(async function (this: unknown) { expect(this).toBe(original); }),
    afterEngineEventAcknowledged: vi.fn(function (this: unknown) { expect(this).toBe(original); }) };
  const settle = vi.fn(), port = withNativeTerminalCommitBarrier(original, settle), pending = request();
  pending.record.body = { case: undefined };
  const receipt = await port.commit(pending);
  await port.commitProviderFrontier!({} as never, new AbortController().signal);
  port.afterEngineEventAcknowledged!(pending.record, receipt);
  expect(settle).not.toHaveBeenCalled(); expect(original.commit).toHaveBeenCalledOnce();
});

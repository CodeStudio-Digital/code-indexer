import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import { ControlPlaneFileRepository } from '@mcp/session-storage';
import type { FsConversationRuntimeOutcome } from '@mcp/session-storage/fs-store/index.js';
import { resolveNativeProductOutcome } from '../native-history-outcome.js';
import { runtimeRequestId } from '../runtime-attempt-ledger.js';

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'native-history-outcome-')); roots.push(root);
  const repository = new ControlPlaneFileRepository({ sessionRoot: root });
  const sessionId = randomUUID();
  const current: FsConversationRuntimeOutcome = { runtimeGeneration: 'rust_v1',
    agentRunId: randomUUID(), attemptId: randomUUID(), status: 'running' };
  const run = { sessionId, agentRunId: current.agentRunId, activeAttemptId: current.attemptId, status: 'running' };
  await repository.create('run', { id: run.agentRunId, relations: { session: sessionId }, data: { status: run.status, run } });
  const terminalize = (status: string, terminalReason: string, activeAttemptId = current.attemptId) =>
    repository.update('run', run.agentRunId, { data: { status, run: { ...run, activeAttemptId,
      status, terminalReason, finishedAt: new Date().toISOString() } } });
  const cancel = (relationSession = sessionId) => repository.create('runtimeRequest', {
    id: runtimeRequestId(current.attemptId, 'cancel'), relations: {
      session: relationSession, run: current.agentRunId, attempt: current.attemptId },
    data: { checkpointType: 'runtime-request-v1', key: 'cancel' },
  });
  return { repository, sessionId, current, terminalize, cancel,
    resolve: (value = current) => resolveNativeProductOutcome(repository, sessionId, value) };
}

it('refreshes a cached journal outcome after durable product cancellation without a new journal event', async () => {
  const f = await fixture();
  expect(await f.resolve()).toBe(f.current);
  await f.cancel();
  // A request alone is not acknowledgement that execution stopped.
  expect(await f.resolve()).toBe(f.current);
  await f.terminalize('interrupted', 'aborted');
  expect(await f.resolve()).toMatchObject({ status: 'cancelled', reason: 'aborted' });
  expect(f.current.status).toBe('running');
});

it.each([
  ['failed', 'native_attempt_failed', 'failed', 'native_attempt_failed'],
  ['interrupted', 'max_turns', 'interrupted', 'max_turns'],
  ['aborted', 'host_lost', 'interrupted', 'host_lost'],
  ['completed', 'completed', 'interrupted', 'missing_native_terminal_receipt'],
])('uses product %s conservatively when no Rust terminal was committed', async (status, reason, expected, expectedReason) => {
  const f = await fixture(); await f.terminalize(status, reason);
  expect(await f.resolve()).toMatchObject({ status: expected, reason: expectedReason });
});

it('does not relabel provider loss as cancellation without a matching durable request', async () => {
  const f = await fixture();
  await f.terminalize('interrupted', 'provider_interrupted');
  const value = { ...f.current, status: 'interrupted' as const, reason: 'provider_interrupted' };
  expect(await f.resolve(value)).toBe(value);
  await f.cancel();
  expect(await f.resolve(value)).toMatchObject({ status: 'cancelled' });
});

it.each(['completed', 'interrupted', 'failed'] as const)('keeps engine %s pending until Host cleanup is terminal', async status => {
  const f = await fixture(); await f.cancel();
  const value = { ...f.current, status };
  expect(await f.resolve(value)).toMatchObject({ status: 'running', reason: 'native_host_cleanup_pending' });
  await f.terminalize('failed', 'native_host_cleanup_failed');
  expect(await f.resolve(value)).toMatchObject({ status: 'failed', reason: 'native_host_cleanup_failed' });
});

it('requires both engine and product completion to expose success', async () => {
  const f = await fixture(); const value = { ...f.current, status: 'completed' as const };
  await f.terminalize('completed', 'completed');
  expect(await f.resolve(value)).toBe(value);
  await f.terminalize('interrupted', 'host_lost');
  expect(await f.resolve(value)).toMatchObject({ status: 'interrupted', reason: 'host_lost' });
});

it('does not borrow a terminal from a later attempt or overwrite a completed Rust terminal', async () => {
  const f = await fixture(); await f.cancel(); await f.terminalize('interrupted', 'aborted', randomUUID());
  expect(await f.resolve()).toBe(f.current);
  const completed = { ...f.current, status: 'completed' as const };
  expect(await f.resolve(completed)).toBe(completed);
});

it('rejects cancellation from another session', async () => {
  const f = await fixture(); await f.cancel(randomUUID()); await f.terminalize('interrupted', 'aborted');
  await expect(f.resolve()).rejects.toThrow('cancellation authority changed');
});

it('rejects a run belonging to another session', async () => {
  const f = await fixture();
  await expect(resolveNativeProductOutcome(f.repository, randomUUID(), f.current)).rejects.toThrow('run authority changed');
});

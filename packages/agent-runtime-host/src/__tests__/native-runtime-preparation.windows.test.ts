import { createHash, randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { create } from '@bufbuild/protobuf';
import { agentV1Artifact as artifact } from '@mcp/agent-runtime-contracts';
import { expect, it, vi } from 'vitest';
import { NativeRustHostAttemptRuntime } from '../native/NativeRustHostAttemptRuntime.js';
import { NativeAttemptLease } from '../native/NativeAttemptLease.js';
import { processRealFixture, type ProcessRealFixture } from './native-process-real-active-support.js';

const physicalIt = process.platform === 'win32' && process.env.MCP_RUST_AGENT_PROCESS_REAL_E2E === '1' ? it : it.skip;
const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

function observedBinding(fixture: ProcessRealFixture, slowOpen = false) {
  const binding = fixture.options.binding;
  const openSupervisor = vi.fn(binding.openHostSupervisorBridge.bind(binding));
  const closeStore = vi.fn<() => Promise<'closed'>>();
  const openStore = vi.fn<typeof binding.openNativeSessionStoreBridge>((...args) => {
    const bridge = binding.openNativeSessionStoreBridge(...args); let first = true;
    closeStore.mockImplementation(() => bridge.close());
    return { get isClosed() { return bridge.isClosed; }, close: closeStore,
      async handle(bytes: Uint8Array, now: number) {
        if (first && slowOpen) { first = false; expect(openSupervisor).not.toHaveBeenCalled(); await delay(200); }
        return bridge.handle(bytes, now);
      },
    };
  });
  return { openSupervisor, closeStore, openStore, binding: { ...binding,
    openHostSupervisorBridge: openSupervisor, openNativeSessionStoreBridge: openStore } };
}

physicalIt('opens the real journal and commits slow attachments before starting either Rust process', async () => {
  const fixture = await processRealFixture(), observed = observedBinding(fixture, true), bytes = Buffer.from('durable prepared attachment');
  const reference = create(artifact.ArtifactRefSchema, { artifactId: randomUUID(), ownerSessionId: fixture.options.sessionStore!.sessionId,
    kind: 'image', mediaType: 'image/png', byteLength: BigInt(bytes.length), contentSha256: createHash('sha256').update(bytes).digest(),
    compression: artifact.ArtifactCompression.NONE, privacyClass: artifact.ArtifactPrivacyClass.CONFIDENTIAL,
    redactionPolicyVersion: 'initial-conversation-v1' });
  const deadline = fixture.options.openDeadlineAtUnixMs, hardDeadline = fixture.options.launch.hardDeadlineAtUnixMs;
  const beforeSpawn = vi.fn();
  let runtime: NativeRustHostAttemptRuntime | undefined;
  try {
    runtime = await NativeRustHostAttemptRuntime.create({ ...fixture.options, binding: observed.binding, beforeSupervisorSpawn: beforeSpawn,
      sessionStoreReady: async store => {
        expect(observed.openSupervisor).not.toHaveBeenCalled(); expect(beforeSpawn).not.toHaveBeenCalled();
        expect(fixture.observed.runnerProcessId).toBeUndefined();
        await store.commitAttachment(reference, { async read() {
          // Longer than the supervisor's old unserviced startup margin.
          await delay(11_000); expect(observed.openSupervisor).not.toHaveBeenCalled(); return bytes;
        } }, new AbortController().signal);
        expect(observed.openSupervisor).not.toHaveBeenCalled();
      },
    });
    expect(observed.openSupervisor).toHaveBeenCalledOnce();
    expect(beforeSpawn).toHaveBeenCalledOnce();
    expect(fixture.options.openDeadlineAtUnixMs).toBe(deadline);
    expect(fixture.options.launch.hardDeadlineAtUnixMs).toBe(hardDeadline);
    const started = await runtime.run(fixture.prepare);
    expect(started.kind).toBe('active');
    if (started.kind !== 'active') throw new Error('Native fixture did not activate');
    const lease = new NativeAttemptLease(runtime, started.authority, fixture.options.launch.identity!.attemptId, {
      deadlineAtUnixMs: fixture.options.control.specDeadlineAtUnixMs,
      cancelGraceMs: fixture.options.launch.resourceBudget!.cancelGraceMs,
    }, fixture.options.data.clock);
    await lease.closed;
    expect(fixture.observed.providerRunCount).toBe(2);
    expect(fixture.observed.capabilityPrepareCount).toBe(1);
    expect(fixture.committedFacts.at(-1)).toBe('attemptProcessReaped');
    expect(() => process.kill(fixture.observed.runnerProcessId!, 0)).toThrow();
  } finally { await runtime?.close(); await rm(fixture.sessionRoot!, { recursive: true, force: true }); }
}, 60_000);

physicalIt.each(['cancelled', 'lost-authority', 'expired'] as const)('closes the prepared journal without spawning when preparation is %s', async fault => {
  const fixture = await processRealFixture(), observed = observedBinding(fixture), ctrl = new AbortController();
  const cause = new Error(`preparation ${fault}`);
  const beforeSpawn = vi.fn();
  const deadline = fault === 'expired' ? BigInt(Date.now() + 1_000) : fixture.options.openDeadlineAtUnixMs;
  let runtime: NativeRustHostAttemptRuntime | undefined;
  const ready = vi.fn(async () => {
    expect(observed.openSupervisor).not.toHaveBeenCalled();
    if (fault === 'cancelled') ctrl.abort(cause);
    if (fault === 'lost-authority') throw cause;
    if (fault === 'expired') await delay(1_100);
  });
  try {
    const createRuntime = NativeRustHostAttemptRuntime.create({ ...fixture.options, binding: observed.binding,
      openDeadlineAtUnixMs: deadline, sessionStoreReady: ready, beforeSupervisorSpawn: beforeSpawn }, ctrl.signal).then(value => { runtime = value; return value; });
    await expect(createRuntime).rejects.toThrow(fault === 'expired' ? /expired|deadline/i : cause.message);
    expect(ready).toHaveBeenCalledOnce(); expect(observed.openStore).toHaveBeenCalledOnce();
    expect(observed.closeStore).toHaveBeenCalledOnce(); expect(observed.openSupervisor).not.toHaveBeenCalled();
    expect(beforeSpawn).not.toHaveBeenCalled();
    expect(fixture.observed.runnerProcessId).toBeUndefined(); expect(fixture.observed.providerRunCount).toBe(0);
    expect(fixture.committedFacts).toEqual([]);
    expect(fixture.options.openDeadlineAtUnixMs).toBeGreaterThanOrEqual(deadline);
  } finally { await runtime?.close(); await rm(fixture.sessionRoot!, { recursive: true, force: true }); }
}, 30_000);

physicalIt('rejects an already cancelled preparation before opening the store or supervisor', async () => {
  const fixture = await processRealFixture(), observed = observedBinding(fixture), ctrl = new AbortController();
  const beforeSpawn = vi.fn();
  ctrl.abort(new Error('cancelled before preparation'));
  try {
    await expect(NativeRustHostAttemptRuntime.create({ ...fixture.options, binding: observed.binding, beforeSupervisorSpawn: beforeSpawn }, ctrl.signal)).rejects.toThrow('cancelled before preparation');
    expect(observed.openStore).not.toHaveBeenCalled(); expect(observed.openSupervisor).not.toHaveBeenCalled();
    expect(beforeSpawn).not.toHaveBeenCalled();
  } finally { await rm(fixture.sessionRoot!, { recursive: true, force: true }); }
}, 30_000);

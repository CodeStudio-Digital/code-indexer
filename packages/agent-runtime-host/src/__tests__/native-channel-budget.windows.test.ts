import { rm } from 'node:fs/promises';
import { expect, it, vi } from 'vitest';
import { agentV1SessionStore as journal } from '@mcp/agent-runtime-contracts';
import { NativeRustHostAttemptRuntime } from '../native/NativeRustHostAttemptRuntime.js';
import { NativeAttemptLease } from '../native/NativeAttemptLease.js';
import { processRealFixture } from './native-process-real-active-support.js';

const physicalIt = process.platform === 'win32' && process.env.MCP_RUST_AGENT_PROCESS_REAL_E2E === '1' ? it : it.skip;

physicalIt('settles a live provider and reaps before the negotiated Management identities run out', async () => {
  let release!: () => void;
  const stalled = new Promise<void>(resolve => { release = resolve; });
  const fixture = await processRealFixture(false, true, undefined, 1, () => stalled);
  const runtime = await NativeRustHostAttemptRuntime.create(fixture.options);
  let lease: NativeAttemptLease | undefined;
  try {
    const active = await runtime.run(fixture.prepare);
    if (active.kind !== 'active') throw new Error('Native budget launch rejected');
    const terminal = runtime.waitForTerminal();
    lease = new NativeAttemptLease(runtime, active.authority, fixture.options.launch.identity!.attemptId,
      { deadlineAtUnixMs: fixture.options.launch.hardDeadlineAtUnixMs, cancelGraceMs: 750n });
    await vi.waitFor(() => expect(fixture.observed.toolResultObserved).toBe(true), { timeout: 10_000 });
    const initial = runtime.inspectActive(active.authority).remainingManagementIdentities!;
    expect(initial).toBeGreaterThan(8);
    expect(initial).toBeLessThan(16);
    for (let index = 1; index <= initial - 8; index++) {
      await runtime.renewAuthority(active.authority, {
        leaseExpiresAtUnixMs: fixture.options.launch.authorityLeaseExpiresAtUnixMs + BigInt(index),
        updatedAtUnixMs: BigInt(Date.now()), idempotencyKey: `management-budget:${index}`,
      });
      expect(runtime.inspectActive(active.authority).remainingManagementIdentities).toBe(initial - index);
    }
    await expect(terminal).resolves.toMatchObject({ body: { case: 'terminal', value: {
      classification: journal.EngineTerminalClassificationV1.INTERRUPTED, reasonCode: 'ipc_identity_budget',
    } } });
    await lease.closed;
    expect(runtime.identityBudgetSignal.aborted).toBe(true);
    expect(fixture.observed.providerRunCount).toBe(2);
    expect(fixture.observed.capabilityPrepareCount).toBe(1);
    expect(fixture.committedFacts.slice(-2)).toEqual(['attemptProcessExited', 'attemptProcessReaped']);
    expect(fixture.observed.reaped?.resourceGroupId).toBeTruthy();
    expect(fixture.observed.reaped?.releasedResources.length).toBeGreaterThan(0);
  } finally {
    release();
    await runtime.close().catch(() => undefined);
    await lease?.closed.catch(() => undefined);
    await rm(fixture.sessionRoot!, { recursive: true, force: true });
  }
}, 30_000);

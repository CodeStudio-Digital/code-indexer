import { fromBinary } from '@bufbuild/protobuf';
import { rm } from 'node:fs/promises';
import { agentV1Runtime } from '@mcp/agent-runtime-contracts';
import { expect, it, vi } from 'vitest';
import { nativePrepareAttempt, provisionNativeAttempt } from '../native/NativeAttemptProvisioning.js';
import { NativeRustHostAttemptRuntime } from '../native/NativeRustHostAttemptRuntime.js';
import { NativeAttemptLease } from '../native/NativeAttemptLease.js';
import { processRealFixture } from './native-process-real-active-support.js';

const physicalIt = process.platform === 'win32' && process.env.MCP_RUST_AGENT_PROCESS_REAL_E2E === '1' ? it : it.skip;

physicalIt.each([120_000, -120_000])('keeps one anchor across wall jumps and terminal cleanup at offset %i', async finalOffset => {
  const realNow = Date.now.bind(Date);
  let offset = 0;
  let held = false;
  let release!: () => void;
  const hold = new Promise<void>(resolve => { release = resolve; });
  const fixture = await processRealFixture(false, true, undefined, 4, async () => { held = true; await hold; });
  const spec = fromBinary(agentV1Runtime.ResolvedAttemptSpecSchema, fixture.prepare.encodedSpec);
  spec.deadlineAtUnixMs = BigInt(realNow() + 30_000);
  const options = provisionNativeAttempt({ spec, runtimePackage: fixture.options.runtimePackage,
    leaseExpiresAtUnixMs: spec.deadlineAtUnixMs,
    activationAuthoritySeal: fixture.options.launch.activationAuthoritySeal!,
    requiredContainmentLevel: fixture.options.control.requiredContainmentLevel,
    requiredEnforcedLimits: fixture.options.control.requiredEnforcedLimits,
    durability: { async commitPrepared(facts, control) {
      const grant = await fixture.options.control.durability.commitPrepared(facts, control);
      grant.activate.deadlineAtUnixMs = spec.deadlineAtUnixMs;
      return grant;
    } },
    durableFacts: () => fixture.options.durableFacts, source: fixture.options.data.source,
    providerGatewayFactory: fixture.options.data.providerGatewayFactory!,
    capabilityGatewayFactory: fixture.options.data.capabilityGatewayFactory!,
    sessionStore: fixture.options.sessionStore!, integrationMode: 'test',
  });
  let runtime: NativeRustHostAttemptRuntime | undefined;
  let tick: ReturnType<typeof setInterval> | undefined;
  const wall = vi.spyOn(Date, 'now').mockImplementation(() => realNow() + offset);
  try {
    const runtimeOptions = finalOffset > 0 ? { ...options, binding: { ...options.binding,
      async openHostSupervisorBridge(encoded: Uint8Array) {
        // A cold DLL/process setup may exceed the old, unrelated 10s margin.
        // No process is started by the seam until the delay has finished.
        await new Promise(resolve => setTimeout(resolve, 12_000));
        return options.binding.openHostSupervisorBridge(encoded);
      },
    } } : options;
    runtime = await NativeRustHostAttemptRuntime.create(runtimeOptions);
    // Control driver is constructed after this jump, during launch.
    offset = 120_000;
    const started = await runtime.run(nativePrepareAttempt(spec));
    expect(started.kind).toBe('active');
    if (started.kind !== 'active') throw new Error('Native launch rejected after forward wall-clock jump');
    tick = setInterval(() => runtime!.tick(), 50);
    await vi.waitFor(() => expect(held).toBe(true), { timeout: 10_000 });
    for (const jump of [120_000, -120_000]) {
      offset = jump;
      const before = options.supervisor.nowUnixMs();
      await new Promise(resolve => setTimeout(resolve, 1_100));
      const after = options.supervisor.nowUnixMs();
      expect(after - before).toBeGreaterThanOrEqual(1_000n);
      expect(after - before).toBeLessThan(5_000n);
      for (const read of [() => options.control.clock!.now(), () => options.data.clock.now(), options.sessionStore!.nowUnixMs]) {
        expect(read() - after).toBeGreaterThanOrEqual(0n);
        expect(read() - after).toBeLessThan(250n);
      }
      expect(runtime.isFailed).toBe(false);
      expect(runtime.inspectActive(started.authority).heartbeat).toBeDefined();
    }
    expect(await runtime.inspectUnresolvedCapabilityDispatches(64)).toEqual([]);
    clearInterval(tick); tick = undefined;
    offset = finalOffset;
    const lease = new NativeAttemptLease(runtime, started.authority, spec.identity!.attemptId, {
      deadlineAtUnixMs: spec.deadlineAtUnixMs, cancelGraceMs: spec.resourceBudget!.cancelGraceMs,
    }, options.data.clock);
    release(); await lease.closed;
    expect(fixture.observed.providerRunCount).toBe(2);
    expect(fixture.observed.capabilityPrepareCount).toBe(4);
    expect(fixture.committedFacts.at(-1)).toBe('attemptProcessReaped');
    expect(() => process.kill(fixture.observed.runnerProcessId!, 0)).toThrow();
  } finally {
    wall.mockRestore(); release(); if (tick) clearInterval(tick);
    await runtime?.close();
    await rm(fixture.sessionRoot!, { recursive: true, force: true });
  }
}, 60_000);

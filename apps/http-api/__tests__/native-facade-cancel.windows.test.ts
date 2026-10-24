import { rm } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fromBinary } from '@bufbuild/protobuf';
import { agentV1Runtime } from '@mcp/agent-runtime-contracts';
import { ProviderGateway, type NativeRustHostAttemptRuntime } from '@mcp/agent-runtime-host';
import type { ChatRequest } from '@mcp/provider-sdk/adapter.js';
import { expect, it, vi } from 'vitest';
import { processRealFixture } from '../../../packages/agent-runtime-host/src/__tests__/native-process-real-active-support.js';
import { supervisorFactFixture } from './supervisor-fact-fixture.js';
import { activateNativeCoderRuntimeFacade } from '../sse/native-coder-runtime-facade.js';
import { NativeCoderInteractions } from '../sse/native-coder-interactions.js';
import { createBus } from '../coder-bus.js';

const physicalIt = process.platform === 'win32' && process.env.MCP_RUST_AGENT_PROCESS_REAL_E2E === '1' ? it : it.skip;
physicalIt.each([{ drainFails: false, routingDelayMs: 0 }, { drainFails: true, routingDelayMs: 0 },
  { drainFails: false, routingDelayMs: 11_000 }])(
  'cancels a native facade after Host drain (drain failure: $drainFails, routing delay: $routingDelayMs)', async ({ drainFails, routingDelayMs }) => {
  const product = await supervisorFactFixture('coder');
  const cancelRequests = vi.spyOn(product.store, 'commitRuntimeRequest');
  const fixture = await processRealFixture(false, true, undefined, 1, undefined, undefined, product.identity);
  const bus = createBus(new AbortController());
  const interactions = new NativeCoderInteractions(bus.ctrl.signal);
  let runtime: NativeRustHostAttemptRuntime | undefined;
  let supervisorPid: number | undefined;
  let providerAborted = false;
  let textVisible!: () => void;
  const visible = new Promise<void>((resolve) => { textVisible = resolve; });
  let drainEntered!: () => void; let drainRelease!: () => void;
  const draining = new Promise<void>(resolve => { drainEntered = resolve; });
  const drain = new Promise<void>(resolve => { drainRelease = resolve; });
  bus.subscribers.add((row) => { if (row.event === 'text') textVisible(); });
  const provider = { name: 'openai', model: 'gpt-5', setModel() {}, async *chat(request: ChatRequest) {
    yield { type: 'text_delta' as const, text: 'cancel-ready' };
    await new Promise<void>((resolve) => {
      const abort = () => { providerAborted = true; resolve(); };
      if (request.signal?.aborted) abort(); else request.signal?.addEventListener('abort', abort, { once: true });
    });
    yield { type: 'done' as const };
  } };
  try {
    const spec = fromBinary(agentV1Runtime.ResolvedAttemptSpecSchema, fixture.prepare.encodedSpec);
    spec.deadlineAtUnixMs = BigInt(Date.now() + 45_000);
    const attached = await activateNativeCoderRuntimeFacade({ store: product.store, context: product.context, spec,
      runtimePackage: fixture.options.runtimePackage, requiredContainmentLevel: fixture.options.control.requiredContainmentLevel,
      requiredEnforcedLimits: fixture.options.control.requiredEnforcedLimits, source: fixture.options.data.source,
      capabilityGatewayFactory: fixture.options.data.capabilityGatewayFactory!,
      providerGatewayFactory: (context, clock) => new ProviderGateway({ runtimeInstanceId: context.runtimeInstanceId,
        resolver: { resolve: () => provider }, now: () => Number(clock.now()) }),
      sessionStore: fixture.options.sessionStore!, integrationMode: 'test', bus, environmentKind: 'host',
      capabilityCatalogVersion: '1', capabilityIds: ['native.read_file'], eligibility: { evaluate: async () => {
        // Exceeds the old 10-second launch margin, without extending the spec
        // deadline or executor lease. Routing is before physical provisioning.
        if (routingDelayMs) await delay(routingDelayMs);
        return { eligible: true, reasons: [] };
      } },
      assertOwner() {}, provideInput: (id, value) => interactions.provideInput(id, value),
      async drainHostEffects() { drainEntered(); await drain; if (drainFails) throw new Error('Host cleanup proof missing'); },
      runSpec: { schemaVersion: 1, sessionId: product.context.sessionId, commandId: product.context.commandId,
        spawnDepth: 0, role: 'coder', agentDefinitionId: 'coder', task: { text: 'cancel native provider' },
        requestedCapabilityProfile: 'full', requestedEnvironment: { kind: 'host', projectId: 'fixture', access: 'exclusive_write', retention: 'retain_on_failure' },
        waitMode: 'foreground', budget: { maxWallMs: 60_000 }, idempotencyKey: product.context.commandId },
      runtimeCreated(value) { runtime = value; supervisorPid = value.supervisorProcessId; },
    });
    await visible;
    const pending = interactions.waitForInput('pending-during-cancel');
    // Product Stop aborts the public bus and forwards an explicit RPC. The
    // attempt owner must join both callers before its terminal revokes main's
    // worker authority, rather than start another authority transaction.
    bus.ctrl.abort({ code: 'user_cancelled' });
    const cancellation = attached.handle.cancel({ code: 'user_cancelled' });
    expect(attached.handle.cancel({ code: 'user_cancelled' })).toBe(cancellation);
    await cancellation;
    expect(cancelRequests.mock.calls.filter(([, key]) => key === 'cancel')).toHaveLength(1);
    expect(JSON.parse(await pending)).toEqual({ aborted: true });
    await draining;
    expect(bus.ended).toBe(false);
    expect((await attached.handle.getSnapshot()).run.status).not.toBe('interrupted');
    drainRelease();
    if (drainFails) await expect(attached.closed).rejects.toThrow('Host cleanup proof missing');
    else await attached.closed;
    expect(providerAborted).toBe(true);
    expect((await attached.handle.getSnapshot()).run.status).toBe(drainFails ? 'failed' : 'interrupted');
    expect(bus.endReason).toMatchObject({ event: drainFails ? 'error' : 'done',
      data: { reason: drainFails ? 'native_host_cleanup_failed' : 'aborted' } });
    expect((await product.repository.list('supervisorFact')).items).toHaveLength(5);
    expect(() => process.kill(supervisorPid!, 0)).toThrow();
    expect(await interactions.provideInput('pending-during-cancel', 'late')).toBe(false);
  } finally {
    drainRelease();
    interactions.close(); await runtime?.close(); await product.sessions.close();
    await rm(product.directory, { recursive: true, force: true });
    await rm(fixture.sessionRoot!, { recursive: true, force: true });
  }
}, 120_000);

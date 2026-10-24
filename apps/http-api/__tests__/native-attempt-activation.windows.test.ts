import { fromBinary } from '@bufbuild/protobuf';
import { agentV1Runtime } from '@mcp/agent-runtime-contracts';
import { rm } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { NativeAttemptLease } from '../../../packages/agent-runtime-host/src/native/NativeAttemptLease.js';
import { NativeRustHostAttemptRuntime } from '../../../packages/agent-runtime-host/src/native/NativeRustHostAttemptRuntime.js';
import { processRealFixture } from '../../../packages/agent-runtime-host/src/__tests__/native-process-real-active-support.js';
import { supervisorFactFixture } from './supervisor-fact-fixture.js';
import { nativeFixtureRoute } from './native-attempt-fixture.js';
import { prepareNativeProductAttempt } from '../native-attempt-runtime.js';

const physicalIt = process.platform === 'win32' && process.env.MCP_RUST_AGENT_PROCESS_REAL_E2E === '1' ? it : it.skip;
physicalIt('launches and activates Rust with the actual durable product grant instead of a fixture grant', async () => {
  const product = await supervisorFactFixture('coder');
  let native: Awaited<ReturnType<typeof processRealFixture>> | undefined;
  let runtime: NativeRustHostAttemptRuntime | undefined;
  try {
    native = await processRealFixture(false, true, undefined, 1, undefined, undefined, product.identity);
    const spec = fromBinary(agentV1Runtime.ResolvedAttemptSpecSchema, native.prepare.encodedSpec);
    spec.deadlineAtUnixMs = BigInt(Date.now() + 45_000);
    const prepared = await prepareNativeProductAttempt({
      store: product.store, context: product.context, spec, runtimePackage: native.options.runtimePackage,
      requiredContainmentLevel: native.options.control.requiredContainmentLevel,
      requiredEnforcedLimits: native.options.control.requiredEnforcedLimits,
      source: native.options.data.source, providerGatewayFactory: native.options.data.providerGatewayFactory!,
      capabilityGatewayFactory: native.options.data.capabilityGatewayFactory!, sessionStore: native.options.sessionStore!, integrationMode: 'test',
    });
    await nativeFixtureRoute(product, native.options.runtimePackage.manifest.buildId, native.options.runtimePackage.binaries.runner.sha256);
    const durableFacts = prepared.options.durableFacts;
    const observe = native.options.durableFacts;
    runtime = await NativeRustHostAttemptRuntime.create({ ...prepared.options,
      durableFacts: { async commit(...args) { await durableFacts.commit(...args); await observe.commit(...args); } },
    });
    const launched = await runtime.run(prepared.prepare);
    expect(launched.kind).toBe('active');
    if (launched.kind !== 'active') throw new Error('Rust launch was rejected');
    const state = await product.store.getAttemptState(product.context);
    expect(state.run).toMatchObject({ status: 'running', effectiveProvider: 'openai', effectiveModel: 'gpt-5', version: 3 });
    expect(state.attempt).toMatchObject({ status: 'running', version: 2 });
    const lease = new NativeAttemptLease(runtime, launched.authority, product.context.attemptId, {
      deadlineAtUnixMs: native.options.control.specDeadlineAtUnixMs,
      cancelGraceMs: native.options.launch.resourceBudget!.cancelGraceMs,
    });
    await lease.closed;
    expect(native.observed.providerRunCount).toBe(2);
    expect(native.observed.toolResultObserved).toBe(true);
    expect((await product.repository.list('nativeActivation')).items).toHaveLength(1);
    expect((await product.repository.list('supervisorFact')).items).toHaveLength(5);
    expect(() => process.kill(native!.observed.runnerProcessId!, 0)).toThrow();
  } finally {
    await runtime?.close(); await product.sessions.close();
    await rm(product.directory, { recursive: true, force: true });
    if (native) await rm(native.sessionRoot!, { recursive: true, force: true });
  }
}, 120_000);

import { createHash } from 'node:crypto';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { agentV1Common, agentV1Runtime } from '@mcp/agent-runtime-contracts';
import { rm, writeFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { NativeAttemptLease } from '../../../packages/agent-runtime-host/src/native/NativeAttemptLease.js';
import { NativeRustHostAttemptRuntime } from '../../../packages/agent-runtime-host/src/native/NativeRustHostAttemptRuntime.js';
import { processRealFixture } from '../../../packages/agent-runtime-host/src/__tests__/native-process-real-active-support.js';
import { supervisorFactFixture } from './supervisor-fact-fixture.js';
import { nativeFixtureRoute } from './native-attempt-fixture.js';
import { prepareNativeProductAttempt } from '../native-attempt-runtime.js';

const physicalIt = process.platform === 'win32' && process.env.MCP_RUST_AGENT_PROCESS_REAL_E2E === '1' ? it : it.skip;
type Fixture = Awaited<ReturnType<typeof processRealFixture>>;
type Product = Awaited<ReturnType<typeof supervisorFactFixture>>;
const reports: unknown[] = [];
function latch() {
  let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

physicalIt.each(['complete', 'cancel'] as const)('runs an admitted child in a distinct physical Rust attempt: %s', async scenario => {
  const product = await supervisorFactFixture('coder');
  const fixtures: Fixture[] = [], runtimes: NativeRustHostAttemptRuntime[] = [];
  const parentEntered = latch(), parentContinue = latch(), childEntered = latch(), childContinue = latch();
  const timeout = setTimeout(() => { parentContinue.resolve(); childContinue.resolve(); }, 45_000);
  const started = performance.now();
  try {
    const parentFixture = await processRealFixture(false, true, undefined, 1,
      async () => { parentEntered.resolve(); await parentContinue.promise; }, undefined, product.identity);
    fixtures.push(parentFixture);
    const parentSpec = fromBinary(agentV1Runtime.ResolvedAttemptSpecSchema, parentFixture.prepare.encodedSpec);
    parentSpec.deadlineAtUnixMs = BigInt(Date.now() + 45_000);
    parentSpec.runTreeBudget = create(agentV1Common.AgentRunBudgetSchema, { maxAgents: 3, maxDepth: 2 });
    const parent = await launch(product, parentFixture, parentSpec, runtimes);
    await parentEntered.promise;
    const request = { idempotencyKey: 'physical-child', role: 'coder', agentDefinitionId: parentSpec.agentDefinitionId,
      taskSha256: createHash('sha256').update(toBinary(agentV1Runtime.TaskInputSchema, parentSpec.task!)).digest('hex'),
      provider: 'openai', model: 'gpt-5', deadlineAtUnixMs: Number(parentSpec.deadlineAtUnixMs) - 1000 };
    const admission = await product.store.admitNativeChild(product.context, request);
    expect(admission.kind).toBe('reserved');
    const identity = create(agentV1Common.AttemptIdentitySchema, { ...admission.context, fencingEpoch: 1n,
      rootAgentRunId: product.context.agentRunId, parentAgentRunId: product.context.agentRunId, ownerAgentRunId: product.context.agentRunId });
    const childFixture = await processRealFixture(false, true, undefined, 1,
      scenario === 'cancel' ? async () => { childEntered.resolve(); await childContinue.promise; } : undefined, undefined, identity);
    fixtures.push(childFixture);
    const childSpec = fromBinary(agentV1Runtime.ResolvedAttemptSpecSchema, childFixture.prepare.encodedSpec);
    childSpec.spawnDepth = 1; childSpec.deadlineAtUnixMs = BigInt(request.deadlineAtUnixMs);
    const child = await launch({ ...product, context: admission.context, identity }, childFixture, childSpec, runtimes);
    expect(parentFixture.observed.runnerProcessId).not.toBe(childFixture.observed.runnerProcessId);
    if (scenario === 'cancel') {
      await childEntered.promise;
      await product.store.commitRuntimeRequest(product.context, 'cancel', { code: 'user_cancelled' });
      await expect(product.store.getAttemptState(admission.context)).rejects.toThrow('cancellation');
      await product.store.commitRuntimeRequest(admission.context, 'cancel', { code: 'ancestor_cancelled' });
      await Promise.all([parent.cancel({ code: 'user_cancelled' }), child.cancel({ code: 'ancestor_cancelled' })]);
    }
    await child.closed;
    await product.store.terminalizeRun({ context: admission.context, status: scenario === 'complete' ? 'completed' : 'interrupted',
      commandStatus: scenario === 'complete' ? 'succeeded' : 'cancelled', reason: scenario });
    expect((await product.store.getCommand(product.context.sessionId, product.context.commandId))?.status).toBe('running');
    if (scenario === 'complete') {
      const replay = await product.store.admitNativeChild(product.context, request);
      expect(replay.kind).toBe('existing'); expect(replay.context).toEqual(admission.context);
      expect(childFixture.observed.providerRunCount).toBe(2);
      parentContinue.resolve();
    }
    await parent.closed;
    expect(fixtures.every(fixture => fixture.observed.reaped && fixture.observed.toolResultObserved)).toBe(true);
    for (const fixture of fixtures) expect(() => process.kill(fixture.observed.runnerProcessId!, 0)).toThrow();
    expect((await product.repository.list('nativeActivation')).items).toHaveLength(2);
    expect((await product.repository.list('supervisorFact')).items).toHaveLength(10);
    reports.push({ scenario, passed: true, durationMs: performance.now() - started,
      rootPid: parentFixture.observed.runnerProcessId, childPid: childFixture.observed.runnerProcessId,
      childProviderCalls: childFixture.observed.providerRunCount, bothReaped: true,
      scope: 'Two physical Rust attempts with durable product admission; executor composition and application ports are not exercised' });
    if (process.env.MCP_NATIVE_CHILD_REPORT) await writeFile(process.env.MCP_NATIVE_CHILD_REPORT, JSON.stringify(reports, null, 2));
  } finally {
    clearTimeout(timeout); parentContinue.resolve(); childContinue.resolve();
    await Promise.allSettled(runtimes.map(runtime => runtime.close()));
    await product.sessions.close(); await rm(product.directory, { recursive: true, force: true });
    for (const fixture of fixtures) if (fixture.sessionRoot) await rm(fixture.sessionRoot, { recursive: true, force: true });
  }
}, 90_000);

async function launch(product: Product, fixture: Fixture, spec: agentV1Runtime.ResolvedAttemptSpec,
  runtimes: NativeRustHostAttemptRuntime[]): Promise<NativeAttemptLease> {
  const prepared = await prepareNativeProductAttempt({ store: product.store, context: product.context, spec,
    runtimePackage: fixture.options.runtimePackage, requiredContainmentLevel: fixture.options.control.requiredContainmentLevel,
    requiredEnforcedLimits: fixture.options.control.requiredEnforcedLimits, source: fixture.options.data.source,
    providerGatewayFactory: fixture.options.data.providerGatewayFactory!, capabilityGatewayFactory: fixture.options.data.capabilityGatewayFactory!,
    sessionStore: fixture.options.sessionStore!, integrationMode: 'test' });
  await nativeFixtureRoute(product, fixture.options.runtimePackage.manifest.buildId, fixture.options.runtimePackage.binaries.runner.sha256);
  const runtime = await NativeRustHostAttemptRuntime.create({ ...prepared.options,
    durableFacts: { async commit(...args) { await prepared.options.durableFacts.commit(...args); await fixture.options.durableFacts.commit(...args); } } });
  runtimes.push(runtime);
  const result = await runtime.run(prepared.prepare);
  if (result.kind !== 'active') throw new Error('Physical native child activation was rejected');
  return new NativeAttemptLease(runtime, result.authority, product.context.attemptId,
    { deadlineAtUnixMs: spec.deadlineAtUnixMs, cancelGraceMs: spec.resourceBudget!.cancelGraceMs });
}

import { createHash, randomBytes } from 'node:crypto';
import { create, toBinary } from '@bufbuild/protobuf';
import { agentV1Common, agentV1Runtime } from '@mcp/agent-runtime-contracts';
import { RuntimeRouter, nativePrepareAttempt } from '@mcp/agent-runtime-host';
import { resourceBudget } from '../../../packages/agent-runtime-host/src/__tests__/attempt-channel-support.js';
import { supervisorFactFixture } from './supervisor-fact-fixture.js';

export async function nativeAttemptFixture() {
  const f = await supervisorFactFixture('coder');
  const snapshots = ['verifier', 'capabilities', 'environment', 'lease', 'policy', 'preset', 'agent'].map((name) => create(agentV1Common.SnapshotRefSchema,
    { ref: `snapshot:${name}`, version: 1n, contentSha256: createHash('sha256').update(name).digest(), origin: 'fixture', schemaId: name, schemaVersion: 1 }));
  const spec = create(agentV1Runtime.ResolvedAttemptSpecSchema, {
    schemaVersion: 1, specVersion: 1n, identity: f.identity, ordinal: 1, trigger: agentV1Runtime.AttemptTrigger.INITIAL,
    role: 'coder', agentDefinitionId: 'coder', task: { body: { case: 'inlineUtf8', value: 'fixture' } },
    providerBinding: { effectiveProvider: 'openai', effectiveModel: 'gpt-5' }, waitMode: agentV1Runtime.AgentRunWaitMode.FOREGROUND,
    deadlineAtUnixMs: BigInt(Date.now() + 60_000), resourceBudget: resourceBudget(), workspaceLeaseFencingEpoch: 1n,
    verifierPolicySnapshot: snapshots[0], capabilitySetSnapshot: snapshots[1], environmentSnapshot: snapshots[2],
    workspaceLeaseSnapshot: snapshots[3], policySnapshot: snapshots[4], presetSnapshot: snapshots[5], agentDefinitionSnapshot: snapshots[6],
  });
  const encodedSpec = toBinary(agentV1Runtime.ResolvedAttemptSpecSchema, spec);
  const prepare = create(agentV1Runtime.PrepareAttemptSchema, { identity: f.identity, encodedSpec, specSchemaVersion: 1,
    expectedSpecSha256: nativePrepareAttempt(spec).expectedSpecSha256,
    expectedSnapshots: snapshots, idempotencyKey: `prepare:${f.context.attemptId}` });
  const nonce = randomBytes(32);
  const input = { prepare, activationNonceSha256: createHash('sha256').update(nonce).digest(),
    requiredContainmentLevel: agentV1Common.ContainmentLevel.HARD_PROCESS, requiredEnforcedLimits: [agentV1Common.ResourceLimitKind.MEMORY] };
  return { ...f, spec, prepare, nonce, input };
}

export async function nativeFixtureRoute(f: Awaited<ReturnType<typeof supervisorFactFixture>>, runtimeBuildId: string, binarySha256 = 'a'.repeat(64)) {
  const router = new RuntimeRouter({
    getByAttemptId: async (id) => await f.store.getRuntimeRoute(f.context.sessionId, id) ?? undefined,
    commitIfAbsent: (record) => f.store.commitRuntimeRoute(f.context, record),
  }, { evaluate: async () => ({ eligible: true, reasons: [] }) });
  return router.route({ sessionId: f.context.sessionId, agentRunId: f.context.agentRunId, attemptId: f.context.attemptId,
    preference: 'rust_required', cohort: 'native-fixture', eligibility: { surface: 'coder.interactive', platform: 'win32-x64',
      environmentKind: 'host', provider: 'openai', capabilityProfile: 'full', capabilityCatalogVersion: '1',
      capabilityIds: ['native.read_file'], engineVersion: 'rust-v1', runtimeBuildId, runtimeBinarySha256: binarySha256,
      protocolVersion: '1.1', requiredContainmentLevel: 'hard_process' } });
}

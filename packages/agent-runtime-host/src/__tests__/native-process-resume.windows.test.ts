import { createHash, randomUUID } from 'node:crypto';
import { readFile, rm } from 'node:fs/promises';
import { create, fromBinary, toBinary } from '@bufbuild/protobuf';
import { agentV1Artifact, agentV1Runtime } from '@mcp/agent-runtime-contracts';
import { expect, it, vi } from 'vitest';
import { NativeRustHostAttemptRuntime } from '../native/NativeRustHostAttemptRuntime.js';
import { NativeDurableEngineEventCommitter } from '../native/NativeDurableEngineEventCommitter.js';
import { ProviderGateway } from '../provider-gateway/ProviderGateway.js';
import { semanticSha256 } from '../ipc/semantic-hash.js';
import { B2_MUTATION_PROBE_TOKEN, processRealFixture } from './native-process-real-active-support.js';

const physicalIt = process.platform === 'win32' && process.env.MCP_RUST_AGENT_PROCESS_REAL_E2E === '1' ? it : it.skip;

physicalIt('preserves an unknown real Host mutation after its result is lost and the journal is reopened', async () => {
  const fixture = await processRealFixture(false, true, undefined, 1, undefined, 'mutating-ack-loss');
  const runtime = await NativeRustHostAttemptRuntime.create(fixture.options);
  let reopened: NativeDurableEngineEventCommitter | undefined;
  try {
    expect((await runtime.run(fixture.prepare)).kind).toBe('active');
    await vi.waitFor(async () => {
      expect(await readFile(fixture.expectedMutationTarget!, 'utf8')).toBe(`${B2_MUTATION_PROBE_TOKEN}\n`);
      const unresolved = await runtime.inspectUnresolvedCapabilityDispatches(64);
      expect(unresolved).toHaveLength(1);
      expect(unresolved[0]?.outcomeUnknownReason).toBeDefined();
    }, { timeout: 10_000 });
    expect(fixture.observed.providerRunCount).toBe(1);
    expect(fixture.observed.capabilityPrepareCount).toBe(1);
    await runtime.close();
    reopened = await NativeDurableEngineEventCommitter.open(fixture.options.binding, {
      ...fixture.options.sessionStore!, instanceId: `uncertain-recovery:${randomUUID()}`,
    });
    await expect(reopened.inspectProviderFrontier(fixture.options.launch.identity!.agentRunId, 64))
      .resolves.toEqual({ status: 'blocked', reason: 'unresolved_effect' });
  } finally {
    await reopened?.close();
    await runtime.close();
    await rm(fixture.sessionRoot!, { recursive: true, force: true });
  }
}, 120_000);

physicalIt('reopens the native journal and resumes in another runner without repeating a settled tool', async () => {
  let release!: () => void;
  const paused = new Promise<void>((resolve) => { release = resolve; });
  const original = await processRealFixture(false, true, undefined, 1, () => paused);
  const runtime = await NativeRustHostAttemptRuntime.create(original.options);
  let resumed: NativeRustHostAttemptRuntime | undefined;
  let reopened: NativeDurableEngineEventCommitter | undefined;
  let next: Awaited<ReturnType<typeof processRealFixture>> | undefined;
  try {
    expect((await runtime.run(original.prepare)).kind).toBe('active');
    await vi.waitFor(() => expect(original.observed.toolResultObserved).toBe(true), { timeout: 10_000 });
    expect(original.observed.capabilityPrepareCount).toBe(1);
    // Dispose every old owner; the recovered bytes must come from the journal.
    await runtime.close();
    reopened = await NativeDurableEngineEventCommitter.open(original.options.binding, {
      ...original.options.sessionStore!, instanceId: `recovery:${randomUUID()}`,
    });
    const recovered = await reopened.inspectProviderFrontier(original.options.launch.identity!.agentRunId, 64);
    expect(recovered.status).toBe('resumable');
    if (recovered.status !== 'resumable') throw new Error(recovered.reason);
    await reopened.close(); reopened = undefined;
    next = await processRealFixture();
    const encodedFrontier = recovered.encodedFrontier;
    const artifact = create(agentV1Artifact.ArtifactRefSchema, {
      artifactId: randomUUID(), kind: 'provider-resume',
      contentSha256: createHash('sha256').update(encodedFrontier).digest(),
      mediaType: 'application/vnd.codestudio.provider-resume.v1+protobuf',
      byteLength: BigInt(encodedFrontier.length), compression: agentV1Artifact.ArtifactCompression.NONE,
      privacyClass: agentV1Artifact.ArtifactPrivacyClass.CONFIDENTIAL,
      redactionPolicyVersion: 'internal-v1', ownerSessionId: recovered.frontier.sessionId,
    });
    const launch = next.options.launch;
    launch.identity!.attemptId = randomUUID();
    launch.identity!.fencingEpoch += 1n;
    const spec = fromBinary(agentV1Runtime.ResolvedAttemptSpecSchema, next.prepare.encodedSpec);
    spec.identity = launch.identity;
    spec.trigger = agentV1Runtime.AttemptTrigger.WORKER_RECOVERY;
    spec.ordinal = 2;
    spec.checkpointInput = artifact;
    next.prepare.identity = launch.identity;
    next.prepare.encodedSpec = toBinary(agentV1Runtime.ResolvedAttemptSpecSchema, spec);
    next.prepare.expectedSpecSha256 = semanticSha256({ schemaId: 'codestudio.agent.v1.ResolvedAttemptSpec',
      schemaVersion: 1, canonicalBytes: next.prepare.encodedSpec });
    const source = next.options.data.source;
    const ordinal = source.items.length;
    let observedResume = false;
    resumed = await NativeRustHostAttemptRuntime.create({ ...next.options,
      sessionStore: { ...next.options.sessionStore!, rootPath: original.sessionRoot!,
        authority: original.options.sessionStore!.authority, openIdempotencyKey: original.options.sessionStore!.openIdempotencyKey },
      control: { ...next.options.control, expectedArtifacts: [artifact] },
      data: { ...next.options.data, expectedArtifacts: [artifact],
        source: {
          items: [...source.items, { reference: { case: 'artifact', value: artifact }, byteLength: artifact.byteLength }],
          readExact(index, offset, length, signal) {
            signal?.throwIfAborted();
            return index === ordinal ? Promise.resolve(encodedFrontier.slice(Number(offset), Number(offset) + length))
              : source.readExact(index, offset, length, signal);
          },
          close: (cause) => source.close(cause),
        },
        providerGatewayFactory: (context, clock) => new ProviderGateway({
          runtimeInstanceId: context.runtimeInstanceId, now: () => Number(clock.now()),
          resolver: { resolve: () => ({ name: 'openai', model: 'gpt-5', setModel() {},
            async *chat(request) {
              const results = request.messages.flatMap((message) => message.content).filter((block) => block.type === 'tool_result');
              expect(results).toHaveLength(1);
              expect(results[0]?.content).toContain(original.expectedReadContent);
              observedResume = true;
              yield { type: 'response_id' as const, id: 'response/recovered', messageCount: request.messages.length };
              yield { type: 'text_delta' as const, text: 'continued without repeating the tool' };
              yield { type: 'done' as const };
            },
          }) },
        }),
      },
    });
    expect((await resumed.run(next.prepare)).kind).toBe('active');
    await vi.waitFor(() => expect(observedResume).toBe(true), { timeout: 10_000 });
    await vi.waitFor(async () => {
      const inspection = await resumed!.inspectProviderFrontier(spec.identity!.agentRunId, 64);
      expect(inspection.status).toBe('blocked');
      if (inspection.status === 'blocked') expect(inspection.reason).toBe('run_completed');
    }, { timeout: 10_000 });
    expect(next.observed.capabilityPrepareCount).toBe(0);
  } finally {
    release();
    await reopened?.close();
    await resumed?.close();
    await runtime.close();
    await rm(original.sessionRoot!, { recursive: true, force: true });
    if (next) await rm(next.sessionRoot!, { recursive: true, force: true });
  }
}, 120_000);

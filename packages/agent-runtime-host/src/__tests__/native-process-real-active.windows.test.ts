import { create } from '@bufbuild/protobuf';
import { readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import {
  agentV1Common,
  agentV1Runtime,
  agentV1Supervisor,
  packProtocolVersion,
} from '@mcp/agent-runtime-contracts';
import { describe, expect, it, vi } from 'vitest';
import {
  encodeNativeHostSupervisorBridgeOpenRequest,
} from '../adapters/NativeHostSupervisorBridgeRequest.js';
import { encodeManagementFrame, validateManagementFrame } from '../ipc/ManagementFrame.js';
import {
  consumeNativeHostSupervisorBridge,
  openNativeHostSupervisorBridge,
} from '../native/NativeHostSupervisorBridgeOpen.js';
import {
  NativeRustHostAttemptRuntime,
} from '../native/NativeRustHostAttemptRuntime.js';
import { processRealFixture } from './native-process-real-active-support.js';

const enabled = process.platform === 'win32'
  && process.env.MCP_RUST_AGENT_PROCESS_REAL_E2E === '1';
const physicalIt = enabled ? it : it.skip;
const codexEnabled = enabled
  && typeof process.env.MCP_CODEX_B2_BINARY === 'string'
  && typeof process.env.MCP_CODEX_B2_VERSION === 'string'
  && /^[a-f0-9]{64}$/.test(process.env.MCP_CODEX_B2_SCHEMA_DIGEST ?? '');
const codexPhysicalIt = codexEnabled ? it : it.skip;

describe('native process-real Rust attempt', () => {
  codexPhysicalIt('runs Codex app-server inside the attempt Job and reaps the complete tree', async () => {
    const fixture = await processRealFixture(false, true, {
      binary: process.env.MCP_CODEX_B2_BINARY!,
      candidateVersion: process.env.MCP_CODEX_B2_VERSION!,
      protocolSchemaDigest: process.env.MCP_CODEX_B2_SCHEMA_DIGEST!,
    });
    const runtime = await NativeRustHostAttemptRuntime.create(fixture.options);
    let authority: Parameters<typeof runtime.cancelActive>[0] | undefined;
    let phase = 'launch';
    let containedProcessCount = 0;
    let journalRecordCount = 0;
    try {
      const result = await runtime.run(fixture.prepare);
      expect(result.kind).toBe('active');
      if (result.kind !== 'active') throw new Error('Codex B2 launch rejected');
      authority = result.authority;
      phase = 'process-containment';
      const journal = join(
        fixture.sessionRoot!,
        fixture.options.launch.identity!.sessionId,
        'conversation.jsonl',
      );
      await vi.waitFor(async () => {
        const heartbeat = runtime.inspectActive(result.authority).heartbeat;
        containedProcessCount = heartbeat?.resources.processCount ?? 0;
        expect(containedProcessCount).toBeGreaterThanOrEqual(2);
      }, { timeout: 15_000, interval: 100 });
      phase = 'terminal-journal';
      try {
        await vi.waitFor(async () => {
          const lines = (await readFile(journal, 'utf8')).trim().split('\n');
          journalRecordCount = lines.length;
          expect(lines.length).toBeGreaterThanOrEqual(9);
          expect(JSON.parse(lines.at(-1)!).durability).toBe('authoritative');
        }, { timeout: 90_000, interval: 100 });
      } catch (error) {
        const captured = await readFile(journal, 'utf8').catch(() => '<journal unavailable>');
        throw new Error(`Codex B2 journal did not become terminal:\n${captured}`, { cause: error });
      }
      phase = 'capability-settlement';
      await expect(runtime.inspectUnresolvedCapabilityDispatches(64))
        .resolves.toEqual([]);
      expect(fixture.observed.capabilityPrepareCount).toBe(1);
      expect(fixture.observed.providerRunStarted).not.toBe(true);
      expect(fixture.observed.containment?.effectiveContainment).toMatchObject({
        level: agentV1Common.ContainmentLevel.HARD_AGGREGATE,
        capabilities: { processTree: true },
      });
      phase = 'cancel';
      await runtime.cancelActive(result.authority, {
        reason: agentV1Runtime.CancelReason.USER_REQUEST,
        reasonCode: 'codex_supervised_b2_complete',
        graceDeadlineAtUnixMs: BigInt(Date.now() + 750),
        idempotencyKey: `codex-b2-cancel:${result.hello.provenance?.pid}`,
      });
      phase = 'physical-reap';
      await runtime.waitForPhysicalReap();
      expect(fixture.committedFacts.slice(-2)).toEqual([
        'attemptProcessExited',
        'attemptProcessReaped',
      ]);
      expect(fixture.observed.reaped?.resourceGroupId).not.toBe('');
      expect(fixture.observed.finalResources?.peakResidentMemoryBytes ?? 0n)
        .toBeGreaterThan(0n);
      process.stdout.write(`${JSON.stringify({
        kind: 'CODEX_SUPERVISED_B2_EVIDENCE',
        candidateVersion: process.env.MCP_CODEX_B2_VERSION,
        protocolSchemaDigest: process.env.MCP_CODEX_B2_SCHEMA_DIGEST,
        containedProcessCount,
        capabilityPrepareCount: fixture.observed.capabilityPrepareCount,
        journalRecordCount,
        containmentLevel: fixture.observed.containment?.effectiveContainment?.level,
        processTreeOwned: fixture.observed.containment?.effectiveContainment?.capabilities?.processTree,
        resourceGroupId: fixture.observed.reaped?.resourceGroupId,
        peakResidentMemoryBytes: String(
          fixture.observed.finalResources?.peakResidentMemoryBytes ?? 0n,
        ),
        committedFacts: fixture.committedFacts,
      })}\n`);
      phase = 'complete';
    } catch (error) {
      const journal = fixture.sessionRoot
        ? join(fixture.sessionRoot, fixture.options.launch.identity!.sessionId, 'conversation.jsonl')
        : '';
      const captured = journal
        ? await readFile(journal, 'utf8').catch(() => '<journal unavailable>')
        : '<journal unavailable>';
      throw new Error([
        `Codex B2 failed during ${phase}`,
        `facts=${fixture.committedFacts.join(',')}`,
        `providerRuns=${fixture.observed.providerRunCount}`,
        `toolResultObserved=${String(fixture.observed.toolResultObserved)}`,
        captured,
      ].join('\n'), { cause: error });
    } finally {
      if (authority) await runtime.close();
      else await runtime.close().catch(() => undefined);
      await rm(fixture.sessionRoot!, { recursive: true, force: true });
    }
  }, 180_000);

  physicalIt.each([1, 4])('executes %i native reads and resumes the provider from its Rust journal', async (readBatchSize) => {
    const fixture = await processRealFixture(false, true, undefined, readBatchSize);
    const runtime = await NativeRustHostAttemptRuntime.create(fixture.options);
    let authority: Parameters<typeof runtime.cancelActive>[0] | undefined;
    try {
      const result = await runtime.run(fixture.prepare);
      expect(result.kind).toBe('active');
      if (result.kind !== 'active') throw new Error('productive launch rejected');
      authority = result.authority;
      expect(fixture.observed.providerGatewayCreated).toBe(true);
      const journal = join(
        fixture.sessionRoot!,
        fixture.options.launch.identity!.sessionId,
        'conversation.jsonl',
      );
      await vi.waitFor(async () => {
        expect(fixture.observed.providerRunStarted).toBe(true);
        expect(fixture.observed.providerResolved).toBe(true);
        expect(fixture.observed.providerRunCount).toBe(2);
        expect(fixture.observed.toolResultObserved).toBe(true);
        const lines = (await readFile(journal, 'utf8')).trim().split('\n');
        const recordCount = 8 + 5 * readBatchSize;
        expect(fixture.observed.capabilityPrepareCount).toBe(readBatchSize);
        expect(lines).toHaveLength(recordCount);
        expect(lines.map((line) => JSON.parse(line).seq))
          .toEqual(Array.from({ length: recordCount }, (_, index) => index + 1));
        expect(lines.filter((line) => JSON.parse(line).kind === 'checkpoint')).toHaveLength(2);
        expect(lines.filter((line) => JSON.parse(line).kind === 'input')).toHaveLength(readBatchSize);
        expect(lines.filter((line) => JSON.parse(line).kind === 'tool_output')).toHaveLength(readBatchSize);
        expect(lines.filter((line) => JSON.parse(line).kind === 'conversation')).toHaveLength(2);
        expect(lines.filter((line) => JSON.parse(line).kind === 'lifecycle')).toHaveLength(4 + 3 * readBatchSize);
        expect(lines.map((line) => JSON.parse(line).durability)).toEqual([
          'authoritative',
          'durable',
          ...Array(5 * readBatchSize).fill('authoritative'),
          'authoritative',
          'durable',
          'coalesced',
          'coalesced',
          'durable',
          'authoritative',
        ]);
        expect(JSON.parse(lines.at(-1)!).durability).toBe('authoritative');
      }, { timeout: 10_000, interval: 50 });
      await expect(runtime.inspectUnresolvedCapabilityDispatches(64))
        .resolves.toEqual([]);
      await expect(runtime.inspectProviderFrontier(fixture.options.launch.identity!.agentRunId, 64))
        .resolves.toEqual({ status: 'blocked', reason: 'run_completed' });
      await runtime.cancelActive(result.authority, {
        reason: agentV1Runtime.CancelReason.USER_REQUEST,
        reasonCode: 'productive_process_real_complete',
        graceDeadlineAtUnixMs: BigInt(Date.now() + 750),
        idempotencyKey: `productive-cancel:${result.hello.provenance?.pid}`,
      });
      await runtime.waitForPhysicalReap();
    } finally {
      if (authority) {
        await runtime.close();
      } else {
        await runtime.close().catch(() => undefined);
      }
      await rm(fixture.sessionRoot!, { recursive: true, force: true });
    }
  }, 120_000);

  physicalIt('negotiates SupervisorHello over the raw native stream', async () => {
    const fixture = await processRealFixture();
    const request = encodeNativeHostSupervisorBridgeOpenRequest({
      runtimePackage: fixture.options.runtimePackage,
      provision: fixture.options.supervisor,
    });
    const owner = await openNativeHostSupervisorBridge(
      fixture.options.binding,
      request,
    );
    const channel = consumeNativeHostSupervisorBridge(owner);
    try {
      const hello = fixture.options.supervisor.hostHello;
      expect(hello.managementSessionToken).toEqual(
        fixture.options.supervisor.expectedManagementSessionToken,
      );
      expect(hello.managementSessionToken.some((byte) => byte !== 0)).toBe(true);
      const frame = encodeManagementFrame(
        create(agentV1Supervisor.ManagementFrameHeaderSchema, {
          protocolVersion: packProtocolVersion(hello.selectedProtocol!),
          connectionId: hello.connectionId,
          messageId: 'management-bootstrap:host-to-supervisor:1:1',
          streamSeq: 1n,
          sentAtUnixMs: BigInt(Date.now()),
        }),
        create(agentV1Supervisor.ManagementPayloadSchema, {
          body: { case: 'hostSupervisorHello', value: hello },
        }),
      );
      await channel.writeManagement(delimit(frame));
      const inbound = await readDelimited(channel);
      expect(validateManagementFrame(inbound).payload.body.case)
        .toBe('supervisorHello');
    } finally {
      await channel.close();
      await rm(fixture.sessionRoot!, { recursive: true, force: true });
    }
  }, 120_000);

  physicalIt('reaches Active and reaps the supervisor and runner', async () => {
    const fixture = await processRealFixture();
    const runtime = await NativeRustHostAttemptRuntime.create(fixture.options);
    const supervisorProcessId = runtime.supervisorProcessId;
    let runnerProcessId = 0;
    let closed = false;
    try {
      const result = await runtime.run(fixture.prepare);
      expect(result.kind).toBe('active');
      if (result.kind !== 'active') throw new Error('process-real launch rejected');
      const provenance = result.hello.provenance;
      if (!provenance) throw new Error('process-real AgentHello lacks provenance');
      runnerProcessId = provenance.pid;
      expect(runnerProcessId).toBeGreaterThan(0);
      expect(runtime.inspectActive(result.authority)).toMatchObject({
        runtimeInstanceId: provenance.runtimeInstanceId,
        deadlineAtUnixMs: fixture.options.control.specDeadlineAtUnixMs,
      });
      expect(processAlive(supervisorProcessId)).toBe(true);
      expect(processAlive(runnerProcessId)).toBe(true);
      expect(fixture.committedFacts).toEqual([
        'launchAccepted',
        'attemptProcessSpawned',
        'attemptContainmentReport',
      ]);
      expect(fixture.observed.readCount).toBe(7);
      expect(fixture.observed.sourceCloseCause).toBeUndefined();
      await new Promise((resolve) => setTimeout(resolve, 1_200));
      expect(processAlive(supervisorProcessId)).toBe(true);
      expect(processAlive(runnerProcessId)).toBe(true);
      await vi.waitFor(() => {
        expect(runtime.inspectActive(result.authority).heartbeat).toBeDefined();
      }, { timeout: 3_000 });
      const heartbeat = runtime.inspectActive(result.authority).heartbeat;
      expect(heartbeat).toMatchObject({
        lastEventSeq: 0n,
        phase: agentV1Runtime.PhysicalAttemptPhase.ACTIVE,
        resources: {
          spoolBytes: 0n,
        },
      });
      expect(heartbeat!.resources.processCount).toBeGreaterThanOrEqual(1);
      expect(heartbeat!.resources.residentMemoryBytes).toBeGreaterThan(0n);
      expect(heartbeat!.resources.peakResidentMemoryBytes)
        .toBeGreaterThanOrEqual(heartbeat!.resources.residentMemoryBytes);
      expect(heartbeat!.resources.openFileCount).toBeGreaterThan(0);
      const activeSnapshot = runtime.inspectActive(result.authority);
      await runtime.cancelActive(result.authority, {
        reason: agentV1Runtime.CancelReason.USER_REQUEST,
        reasonCode: 'process_real_e2e',
        graceDeadlineAtUnixMs: BigInt(Date.now() + 750),
        idempotencyKey: `process-real-cancel:${runnerProcessId}`,
      });
      expect(activeSnapshot.signal.aborted).toBe(true);
      expect(runtime.isFailed).toBe(false);
      await vi.waitFor(() => {
        expect(processAlive(runnerProcessId)).toBe(false);
      }, { timeout: 3_000, interval: 25 });
      await runtime.waitForPhysicalReap();
      expect(fixture.committedFacts).toEqual([
        'launchAccepted',
        'attemptProcessSpawned',
        'attemptContainmentReport',
        'attemptProcessExited',
        'attemptProcessReaped',
      ]);
      expect(fixture.observed.exitCause)
        .toBe(agentV1Supervisor.PhysicalExitCause.CANCELLED);
      expect(processAlive(supervisorProcessId)).toBe(true);
    } catch (cause) {
      const failedBeforeClose = runtime.isFailed;
      const runnerAliveBeforeClose = processAlive(runnerProcessId);
      const supervisorAliveBeforeClose = processAlive(supervisorProcessId);
      const journalBeforeClose = await readFile(join(
        fixture.sessionRoot!,
        fixture.options.launch.identity!.sessionId,
        'conversation.jsonl',
      ), 'utf8').catch((error: unknown) => `unavailable:${String(error)}`);
      const receipt = await runtime.close();
      closed = true;
      throw new Error(
        `process-real attempt failed; supervisor exit=${receipt.exitCode}`
          + ` forced=${receipt.forced}`
          + ` facts=${fixture.committedFacts.join(',')}`
          + ` hydrationReads=${fixture.observed.readCount}`
          + ` runtimeFailed=${failedBeforeClose}`
          + ` failureCause=${String(runtime.failureCause ?? 'none')}`
          + ` aliveBeforeClose=${supervisorAliveBeforeClose}/${runnerAliveBeforeClose}`
          + ` provider=${fixture.observed.providerRunStarted}/${fixture.observed.providerResolved}`
          + ` exitCause=${fixture.observed.exitCause ?? 'none'}`
          + ` dataFailure=${String(fixture.observed.sourceCloseCause ?? 'none')}`
          + ` journal=${journalBeforeClose}`,
        { cause },
      );
    } finally {
      if (!closed) {
        const receipt = await runtime.close();
        expect(receipt.processId).toBe(supervisorProcessId);
      }
      await rm(fixture.sessionRoot!, { recursive: true, force: true });
    }
    expect(processAlive(supervisorProcessId)).toBe(false);
    expect(processAlive(runnerProcessId)).toBe(false);
  }, 120_000);

  physicalIt('fails closed on divergent hydration and reaps its runner', async () => {
    const fixture = await processRealFixture(true);
    const runtime = await NativeRustHostAttemptRuntime.create(fixture.options);
    const supervisorProcessId = runtime.supervisorProcessId;
    let runnerProcessId = 0;
    try {
      await expect(runtime.run(fixture.prepare)).rejects.toThrow();
      runnerProcessId = fixture.observed.runnerProcessId ?? 0;
      expect(runnerProcessId).toBeGreaterThan(0);
      expect(fixture.observed.sourceCloseCause).toBeDefined();
      const receipt = await runtime.close();
      expect(receipt.processId).toBe(supervisorProcessId);
      expect(processAlive(supervisorProcessId)).toBe(false);
      expect(processAlive(runnerProcessId)).toBe(false);
    } finally {
      await runtime.close().catch(() => undefined);
      await rm(fixture.sessionRoot!, { recursive: true, force: true });
    }
  }, 120_000);

  physicalIt('fences Active on the live Control stream and exits its runner', async () => {
    const fixture = await processRealFixture();
    const runtime = await NativeRustHostAttemptRuntime.create(fixture.options);
    const supervisorProcessId = runtime.supervisorProcessId;
    let runnerProcessId = 0;
    try {
      const result = await runtime.run(fixture.prepare);
      expect(result.kind).toBe('active');
      if (result.kind !== 'active') throw new Error('process-real launch rejected');
      runnerProcessId = result.hello.provenance?.pid ?? 0;
      const snapshot = runtime.inspectActive(result.authority);

      await runtime.fenceActive(result.authority, {
        replacementFencingEpoch: 8n,
        reasonCode: 'process_real_superseded',
        fencedAtUnixMs: BigInt(Date.now()),
        idempotencyKey: `process-real-fence:${runnerProcessId}`,
      });

      expect(snapshot.signal.aborted).toBe(true);
      expect(runtime.isFailed).toBe(false);
      expect(processAlive(supervisorProcessId)).toBe(true);
      await vi.waitFor(() => {
        expect(processAlive(runnerProcessId)).toBe(false);
      }, { timeout: 3_000, interval: 25 });
      await runtime.waitForPhysicalReap();
      expect(fixture.committedFacts.slice(-2)).toEqual([
        'attemptProcessExited',
        'attemptProcessReaped',
      ]);
      expect(fixture.observed.exitCause)
        .toBe(agentV1Supervisor.PhysicalExitCause.FENCED);
    } catch (cause) {
      throw new Error(
        `process-real fence failed; facts=${fixture.committedFacts.join(',')}`
          + ` runtimeFailed=${runtime.isFailed}`
          + ` alive=${processAlive(supervisorProcessId)}/${processAlive(runnerProcessId)}`
          + ` provider=${fixture.observed.providerRunStarted}/${fixture.observed.providerResolved}`
          + ` exitCause=${fixture.observed.exitCause ?? 'none'}`,
        { cause },
      );
    } finally {
      await runtime.close();
      await rm(fixture.sessionRoot!, { recursive: true, force: true });
    }
    expect(processAlive(supervisorProcessId)).toBe(false);
    expect(processAlive(runnerProcessId)).toBe(false);
  }, 120_000);
});

function processAlive(processId: number): boolean {
  if (!Number.isInteger(processId) || processId <= 0) return false;
  try {
    process.kill(processId, 0);
    return true;
  } catch {
    return false;
  }
}

function delimit(frame: Uint8Array): Uint8Array {
  const prefix: number[] = [];
  let length = frame.byteLength;
  do {
    let byte = length & 0x7f;
    length = Math.floor(length / 128);
    if (length > 0) byte |= 0x80;
    prefix.push(byte);
  } while (length > 0);
  return Buffer.concat([Buffer.from(prefix), frame]);
}

async function readDelimited(channel: {
  readManagement(maximumBytes: number): Promise<Uint8Array | null>;
}): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let available = 0;
  let length: number | undefined;
  let prefixBytes = 0;
  while (length === undefined || available < prefixBytes + length) {
    const chunk = await channel.readManagement(16 * 1024);
    if (!chunk) throw new Error('raw native management stream ended');
    chunks.push(chunk);
    available += chunk.byteLength;
    const joined = Buffer.concat(chunks);
    if (length === undefined) {
      let value = 0;
      for (let index = 0; index < Math.min(joined.byteLength, 5); index += 1) {
        const byte = joined[index]!;
        value += (byte & 0x7f) * (2 ** (index * 7));
        if ((byte & 0x80) === 0) {
          length = value;
          prefixBytes = index + 1;
          break;
        }
      }
    }
  }
  return Buffer.concat(chunks).subarray(prefixBytes, prefixBytes + length!);
}

import { create } from '@bufbuild/protobuf';
import {
  agentV1Supervisor,
  packProtocolVersion,
} from '@mcp/agent-runtime-contracts';
import { describe, expect, it } from 'vitest';
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

describe('native process-real Rust attempt', () => {
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
    } catch (cause) {
      const receipt = await runtime.close();
      closed = true;
      throw new Error(
        `process-real attempt failed; supervisor exit=${receipt.exitCode}`
          + ` forced=${receipt.forced}`
          + ` facts=${fixture.committedFacts.join(',')}`
          + ` hydrationReads=${fixture.observed.readCount}`,
        { cause },
      );
    } finally {
      if (!closed) {
        const receipt = await runtime.close();
        expect(receipt.processId).toBe(supervisorProcessId);
      }
    }
    expect(processAlive(supervisorProcessId)).toBe(false);
    expect(processAlive(runnerProcessId)).toBe(false);
  }, 120_000);

  physicalIt('fails closed on divergent hydration and reaps its runner', async () => {
    const fixture = await processRealFixture(true);
    const runtime = await NativeRustHostAttemptRuntime.create(fixture.options);
    const supervisorProcessId = runtime.supervisorProcessId;
    await expect(runtime.run(fixture.prepare)).rejects.toThrow();
    const runnerProcessId = fixture.observed.runnerProcessId ?? 0;
    expect(runnerProcessId).toBeGreaterThan(0);
    expect(fixture.observed.sourceCloseCause).toBeDefined();
    const receipt = await runtime.close();
    expect(receipt.processId).toBe(supervisorProcessId);
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

import { rm } from 'node:fs/promises';
import { fromBinary } from '@bufbuild/protobuf';
import { expect, it } from 'vitest';
import { agentV1Runtime, agentV1Supervisor } from '@mcp/agent-runtime-contracts';
import { NativeRustHostAttemptRuntime } from '../../../packages/agent-runtime-host/src/native/NativeRustHostAttemptRuntime.js';
import { processRealFixture } from '../../../packages/agent-runtime-host/src/__tests__/native-process-real-active-support.js';
import { FileControlPlaneStore } from '../file-control-plane-store.js';
import { supervisorFactFixture } from './supervisor-fact-fixture.js';

const physicalIt = process.platform === 'win32' && process.env.MCP_RUST_AGENT_PROCESS_REAL_E2E === '1' ? it : it.skip;

physicalIt('commits actual supervisor phases through product filesystem authority before ACK', async () => {
  const product = await supervisorFactFixture();
  const native = await processRealFixture(false, true, undefined, 1, undefined, undefined, product.identity);
  const connectionId = native.options.supervisor.expectedConnectionId;
  const durablePort = product.store.createSupervisorFactPort(product.context, connectionId);
  const observe = native.options.durableFacts;
  const receipts: Parameters<typeof durablePort.commit>[] = [];
  let runtime: NativeRustHostAttemptRuntime | undefined;
  let phase = 'create';
  try {
    runtime = await NativeRustHostAttemptRuntime.create({ ...native.options, durableFacts: {
      async commit(fact, binding, control) {
        await durablePort.commit(fact, binding, control);
        receipts.push([fact, binding, control]);
        // Observation is downstream from actual fsync, never its substitute.
        await observe.commit(fact, binding, control);
      },
    } });
    phase = 'activate';
    const launched = await runtime.run(native.prepare);
    expect(launched.kind).toBe('active');
    phase = 'terminal';
    await runtime.waitForTerminal();
    if (launched.kind === 'active') {
      phase = 'cancel';
      await runtime.cancelActive(launched.authority, { reason: agentV1Runtime.CancelReason.HOST_SHUTDOWN, reasonCode: 'fixture_complete',
        graceDeadlineAtUnixMs: BigInt(Date.now() + 750), idempotencyKey: 'fixture_cleanup' });
    }
    phase = 'reap';
    await runtime.waitForPhysicalReap();
    const records = await product.repository.listByRelation('supervisorFact', 'attempt', product.context.attemptId);
    expect(records.items.map((r) => r.data.factCase)).toEqual([
      'launchAccepted', 'attemptProcessSpawned', 'attemptContainmentReport', 'attemptProcessExited', 'attemptProcessReaped',
    ]);
    for (const record of records.items) {
      const payload = fromBinary(agentV1Supervisor.ManagementPayloadSchema, Buffer.from(String(record.data.encodedPayload), 'base64'));
      expect(payload.body.value).toMatchObject({ identity: product.identity });
    }
    const reopened = new FileControlPlaneStore(product.sessions).createSupervisorFactPort(product.context, connectionId);
    const [fact, binding, control] = receipts[0]!;
    await reopened.commit(fact, binding, { ...control, signal: new AbortController().signal, deadlineAtUnixMs: BigInt(Date.now() + 2_000) });
    expect((await product.repository.list('supervisorFact')).items).toHaveLength(5);
    expect(native.observed.providerRunCount).toBe(2);
    expect(() => process.kill(native.observed.runnerProcessId!, 0)).toThrow();
  } catch (cause) {
    throw new Error(`Physical supervisor ledger failed at ${phase}; facts=${native.committedFacts.join(',')}; providers=${native.observed.providerRunCount}; cause=${String(cause)}`, { cause });
  } finally {
    await runtime?.close();
    await product.sessions.close();
    await rm(product.directory, { recursive: true, force: true });
    await rm(native.sessionRoot!, { recursive: true, force: true });
  }
}, 120_000);

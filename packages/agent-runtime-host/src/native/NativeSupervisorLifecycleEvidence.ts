import { randomUUID } from 'node:crypto';
import { create } from '@bufbuild/protobuf';
import { agentV1SessionStore as wire } from '@mcp/agent-runtime-contracts';
import type { VerifiedRuntimePackage } from '../packaging/RuntimePackageTypes.js';
import { loadNativeHostBridge } from './NativeHostBridgeLoader.js';
import { NativeSessionStoreBridgeClient } from './NativeSessionStoreBridgeClient.js';

/** Read physical evidence only after the original supervisor releases its OS
 * lock. This does not acknowledge evidence, start work or release a workspace;
 * the product must reconcile its original durable launch and Host effects. */
export async function inspectNativeSupervisorLifecycleEvidence(runtimePackage: VerifiedRuntimePackage, options: {
  rootPath: string; connectionId: string; sessionId: string; attemptId: string;
}) {
  const instance = `supervisor-evidence:${randomUUID()}`;
  const rootId = 'native-product-sessions';
  const owner = loadNativeHostBridge(runtimePackage).openNativeSessionStoreBridge(instance, rootId, options.rootPath, 128 * 1024);
  const client = new NativeSessionStoreBridgeClient(owner, instance, () => BigInt(Date.now()), 10_000n);
  try {
    const response = await client.request({ case: 'inspectSupervisorLifecycleEvidence', value: create(wire.InspectSupervisorLifecycleEvidenceSchema, {
      rootId, connectionId: options.connectionId, attemptId: options.attemptId,
    }) });
    if (response.case !== 'supervisorLifecycleEvidenceInspected') throw new Error('Native lifecycle evidence response diverged');
    const entry = response.value.entry;
    if (entry && (entry.connectionId !== options.connectionId || entry.exited?.identity?.sessionId !== options.sessionId
      || entry.exited.identity.attemptId !== options.attemptId || entry.reaped?.identity?.sessionId !== options.sessionId
      || entry.reaped.identity.attemptId !== options.attemptId)) throw new Error('Native lifecycle evidence belongs to another authority');
    return entry;
  } finally { await client.close(); }
}

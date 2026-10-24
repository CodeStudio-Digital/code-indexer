import { latestProviderCheckpointBase } from './NativeProviderCheckpointIndex.js';
import { fromBinary, toBinary } from '@bufbuild/protobuf';
import { agentV1Runtime, agentV1SessionStore } from '@mcp/agent-runtime-contracts';
import { inspectUnresolvedCapabilityDispatches, type EngineEventRecoveryStorePort } from './NativeEngineEventRecovery.js';
import { MAX_FRONTIER_BYTES, decodeProviderFrontier, type ProviderFrontier } from './ProviderFrontierCodec.js';

export type ProviderFrontierRecovery = {
  status: 'resumable';
  frontier: agentV1Runtime.ProviderResumeContextV1;
  encodedFrontier: Uint8Array;
  receipt: agentV1SessionStore.CommitSessionRecordReceipt;
} | { status: 'blocked'; reason: 'missing_frontier' | 'effect_after_frontier' | 'unresolved_effect' | 'run_completed' };

/** Reads one immutable journal view. Known terminal effects after the last
 * frontier are also barriers: omitting their results could repeat a mutation. */
export async function inspectProviderFrontier(store: EngineEventRecoveryStorePort,
  sessionId: string, agentRunId: string, maximumRecords: number): Promise<ProviderFrontierRecovery> {
  if (!agentRunId || agentRunId.length > 1_024) throw new Error('frontier run identity invalid');
  const firstCheckpoint = await latestProviderCheckpointBase(store, sessionId, agentRunId, maximumRecords);
  let latest: ProviderFrontier | undefined;
  let receipt: agentV1SessionStore.CommitSessionRecordReceipt | undefined;
  let effectAfter = false;
  let completed = false;
  // Deltas from other runs cannot become a base for the requested run.
  const unresolved = await inspectUnresolvedCapabilityDispatches(store, sessionId, maximumRecords,
    (committed, payload, event) => {
      if (!event) {
        if (payload.length > MAX_FRONTIER_BYTES) throw new Error('provider frontier byte limit');
        const envelope = fromBinary(agentV1Runtime.ProviderFrontierRecordV1Schema, payload);
        if (envelope.frontier?.agentRunId !== agentRunId) return;
        const decoded = decodeProviderFrontier(payload, latest);
        if (decoded.value.sessionId !== sessionId) throw new Error('foreign provider frontier session');
        if (decoded.value.agentRunId !== agentRunId) return;
        if (committed.durability !== agentV1SessionStore.SessionDurabilityClass.AUTHORITATIVE) {
          throw new Error('provider frontier is not authoritative');
        }
        latest = decoded; receipt = committed;
        effectAfter = false;
        return;
      }
      if (event.identity!.agentRunId !== agentRunId) return;
      if (event.body.case === 'capabilityDispatchStarted') effectAfter = true;
      if (event.body.case === 'terminal'
        && event.body.value.classification === agentV1SessionStore.EngineTerminalClassificationV1.COMPLETED) {
        completed = true;
      }
    }, firstCheckpoint);
  if (unresolved.some((item) => item.identity.agentRunId === agentRunId)) {
    return { status: 'blocked', reason: 'unresolved_effect' };
  }
  if (completed) return { status: 'blocked', reason: 'run_completed' };
  if (!latest || !receipt) return { status: 'blocked', reason: 'missing_frontier' };
  if (effectAfter) return { status: 'blocked', reason: 'effect_after_frontier' };
  return { status: 'resumable', frontier: latest.value, receipt,
    encodedFrontier: toBinary(agentV1Runtime.ProviderResumeContextV1Schema, latest.value) };
}

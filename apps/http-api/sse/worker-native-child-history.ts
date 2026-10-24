import type { MessageBridge } from '@mcp/orchestrator-host';
import type { WorkerApplicationOwnerResolver } from './native-application-owner.js';
import { parseNativeChildTranscriptRef } from '../native-child-storage.js';
import { asSessionId } from '@mcp/agent-runtime-contracts';

/** Read authorization only. A lingering worker may display its session's
 * completed children after the execution lease closes; it cannot resume them. */
export function registerWorkerNativeChildHistory(bridge: MessageBridge, getOwner: WorkerApplicationOwnerResolver) {
  return bridge.handle('native.childTranscript.authorize', async payload => {
    const packet = payload as { runId: number; reference: string };
    const target = parseNativeChildTranscriptRef(packet?.reference);
    const owner = await getOwner(packet.runId, true); owner.assertOwner();
    if (target.sessionId !== owner.sessionId) throw new Error('Native transcript belongs to another session');
    const context = owner.store?.resolveSessionChildTranscript
      ? await owner.store.resolveSessionChildTranscript(asSessionId(target.sessionId), packet.reference)
      : owner.config && owner.store?.resolveNativeChildTranscript
        ? await owner.store.resolveNativeChildTranscript(owner.config.context, packet.reference, false)
        : undefined;
    if (!context) throw new Error('Native transcript session authority is unavailable');
    owner.assertOwner(); return context;
  });
}

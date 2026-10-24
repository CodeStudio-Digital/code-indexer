import type { FsSessionStore } from '@mcp/session-storage/fs-store/index.js';
import type { SessionId } from '@mcp/agent-runtime-contracts';
import type { CoderWorkerPool } from '../../../sse/CoderWorkerPool.js';

interface InteractionReply {
  status: 200 | 400 | 409 | 503;
  body: { ok?: boolean; error?: string; code?: string };
}

/** Native history cannot accept a synthetic legacy tool result after a lost
 * worker/ACK. Only the original facade may consume this keyed human response. */
export async function resolveNativeInteraction(input: {
  pool: Pick<CoderWorkerPool, 'getRuntimeHandle' | 'provideUserInput'>;
  sessions: Pick<FsSessionStore, 'loadSessionMessagesTail'>;
  sessionId: SessionId; interactionId: unknown; prefix: string; value: string;
}): Promise<InteractionReply | undefined> {
  const handle = input.pool.getRuntimeHandle?.(input.sessionId);
  if (handle?.runtimeGeneration === 'legacy_ts') return undefined;
  if (!handle && (await input.sessions.loadSessionMessagesTail(input.sessionId, 1))
    ?.runtime_outcome?.runtimeGeneration !== 'rust_v1') return undefined;
  if (typeof input.interactionId !== 'string' || !input.interactionId.startsWith(input.prefix)
    || input.interactionId.length > 1024) {
    return { status: 400, body: { error: 'Native response requires the displayed interaction identity', code: 'INTERACTION_ID_REQUIRED' } };
  }
  if (!handle) return { status: 409, body: { error: 'Native interaction owner is unavailable; reconcile the original attempt',
    code: 'NATIVE_INTERACTION_RECOVERY_REQUIRED' } };
  try {
    return await input.pool.provideUserInput(input.sessionId, input.value, input.interactionId)
      ? { status: 200, body: { ok: true } }
      : { status: 409, body: { error: 'Interaction is no longer pending', code: 'INTERACTION_NOT_PENDING' } };
  } catch {
    return { status: 503, body: { error: 'Interaction delivery could not be confirmed; execution was not retried',
      code: 'INTERACTION_DELIVERY_UNCONFIRMED' } };
  }
}

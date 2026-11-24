import { ErrRequestTimeout, type MessageBridge } from '@mcp/orchestrator-host';
import { CoderWriterRecoveryTimeoutError } from './coder-runtime-errors.js';

// Leave time for dispatch under the ten-minute executor lease, even on a slow disk.
export const SESSION_WRITER_ACQUIRE_TIMEOUT_MS = 5 * 60_000;
export const SESSION_WRITER_IDLE_TIMEOUT_MS = 45_000;

/** One worker host acquires exactly one session writer before accepting any input. */
export async function acquireCoderSessionWriter(bridge: MessageBridge): Promise<void> {
  let idleTimer!: ReturnType<typeof setTimeout>;
  const stalled = new Promise<never>((_, reject) => {
    idleTimer = setTimeout(() => reject(new CoderWriterRecoveryTimeoutError('Session recovery made no progress for 45s')), SESSION_WRITER_IDLE_TIMEOUT_MS);
  });
  const unsubscribe = bridge.on('session.writerProgress', () => idleTimer.refresh());
  try {
    const acquired = await Promise.race([
      bridge.request<{ ok: boolean }>('acquireSessionWriter', {}, { timeoutMs: SESSION_WRITER_ACQUIRE_TIMEOUT_MS }),
      stalled,
    ]);
    if (acquired?.ok !== true) throw new Error('Worker did not acknowledge acquiring the session writer');
  } catch (error) {
    if (error instanceof ErrRequestTimeout) throw new CoderWriterRecoveryTimeoutError(error.message);
    throw error;
  } finally {
    clearTimeout(idleTimer);
    unsubscribe();
  }
}

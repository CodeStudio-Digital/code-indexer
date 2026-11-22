import { parentPort } from 'node:worker_threads';
import type { SessionLocation } from '@mcp/session-storage';
import { ConversationStatsReader } from '@mcp/session-storage/fs-store/conversation-stats.js';

const reader = new ConversationStatsReader();
const port = parentPort!;
port.on('message', ({ reqId, body }: { reqId: number; body: SessionLocation }) => {
  try {
    port.postMessage({ reqId, ok: true, result: reader.read(body) });
  } catch (error) {
    port.postMessage({ reqId, ok: false, error: {
      message: error instanceof Error ? error.message : String(error),
      code: (error as NodeJS.ErrnoException)?.code,
    } });
  }
});
port.postMessage({ kind: 'ready' });

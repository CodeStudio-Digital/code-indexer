import { parentPort } from 'node:worker_threads';
import { buildAngularWorkspaceIndex } from '@mcp/services/lsp/angular-workspace-index.js';

export interface AngularIndexRequest {
  root: string;
  overrides: Readonly<Record<string, string>>;
}

const port = parentPort!;
port.on('message', ({ reqId, body }: { reqId: number; body: AngularIndexRequest }) => {
  try {
    const result = buildAngularWorkspaceIndex(body.root, { overrides: body.overrides }, Date.now());
    port.postMessage({ reqId, ok: true, result });
  } catch (error) {
    port.postMessage({ reqId, ok: false, error: { message: error instanceof Error ? error.message : String(error) } });
  }
});
port.postMessage({ kind: 'ready' });

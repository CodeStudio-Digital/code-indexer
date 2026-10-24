import type { LspApi } from '@mcp/api-bus';
import type { CodeIndexDB } from '@mcp/store/db.js';

interface BridgeLike { handle(name: string, fn: (payload: unknown) => Promise<unknown>): () => void }
interface LspRequestPayload {
  readId?: string; op: 'definition' | 'references' | 'hover'; root: string;
  projectName: string; file: string; position: { line: number; column: number };
}
let box: { handlers: LspApi; db: CodeIndexDB } | null = null;
export function setWorkerLspDeps(deps: { handlers: LspApi; db: CodeIndexDB } | null): void { box = deps; }

/** Per-caller read authority. Cancel the request, not the shared LSP server. */
export function registerWorkerLspHandlers(bridge: BridgeLike): () => void {
  const active = new Map<string, AbortController>(); let closed = false, sequence = 0;
  const offCancel = bridge.handle('lspReadCancel', async payload => {
    const id = (payload as { readId?: unknown }).readId;
    if (typeof id === 'string') active.get(id)?.abort(new Error('Agent LSP read cancelled'));
    return { cancelled: true };
  });
  const offRead = bridge.handle('lspRequest', async payload => {
    if (closed || !box) throw new Error('Agent LSP backend is unavailable');
    const { op, root, file, position, readId } = payload as LspRequestPayload;
    if (!['definition', 'references', 'hover'].includes(op) || typeof root !== 'string' || typeof file !== 'string'
      || !Number.isSafeInteger(position?.line) || position.line < 1 || !Number.isSafeInteger(position?.column) || position.column < 1) throw new Error('Invalid agent LSP input');
    const id = readId ?? 'legacy-' + ++sequence;
    if (typeof id !== 'string' || !/^[a-zA-Z0-9-]{8,128}$/.test(id) || active.has(id) || active.size >= 8) throw new Error('Invalid or saturated agent LSP read');
    const projectId = box.db.getProjectByPath(root)?.id;
    if (projectId == null) throw new Error('Agent LSP project root is not registered');
    const ctrl = new AbortController(); active.set(id, ctrl);
    const timer = setTimeout(() => ctrl.abort(new Error('Agent LSP read exceeded 30 seconds')), 30_000); timer.unref();
    try {
      const result = await box.handlers[op]({ projectId, file, position }, { requestId: id, signal: ctrl.signal, clientInfo: { sourceType: 'internal' } });
      ctrl.signal.throwIfAborted(); return result;
    } finally { clearTimeout(timer); active.delete(id); }
  });
  return () => { closed = true; offRead(); offCancel(); for (const ctrl of active.values()) ctrl.abort(new Error('Agent LSP bridge closed')); };
}

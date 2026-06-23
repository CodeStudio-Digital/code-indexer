/**
 * Main-side bridge handler for agent LSP requests from workers.
 *
 * The LSP router (external servers + index fallback) lives ONCE in the main
 * process; coder/company workers install `workers/lsp-shim.ts`, which RPCs
 * here. Deps come through a mutable box (set by server.ts after createApp)
 * so spawns that happen before wiring still resolve at call time.
 *
 * Failure posture: language nav must never break a run — errors return null
 * and the tool reports "no backend" instead of throwing.
 */
import type { LspApi } from '@mcp/api-bus';
import type { CodeIndexDB } from '@mcp/store/db.js';

interface BridgeLike {
  handle(name: string, fn: (payload: unknown) => Promise<unknown>): () => void;
}

interface LspRequestPayload {
  op: 'definition' | 'references' | 'hover';
  root: string;
  projectName: string;
  file: string;
  position: { line: number; column: number };
}

let box: { handlers: LspApi; db: CodeIndexDB } | null = null;

export function setWorkerLspDeps(deps: { handlers: LspApi; db: CodeIndexDB }): void {
  box = deps;
}

/** Resolve project id from the worker's (root, projectName) pair. */
function resolveProjectId(db: CodeIndexDB, root: string, projectName: string): number | null {
  return db.getProjectByPath(root)?.id ?? db.getProjectByName(projectName)?.id ?? null;
}

export function registerWorkerLspHandlers(bridge: BridgeLike): () => void {
  return bridge.handle('lspRequest', async (payload) => {
    try {
      if (!box) return null;
      const { op, root, projectName, file, position } = payload as LspRequestPayload;
      const projectId = resolveProjectId(box.db, root, projectName);
      if (projectId == null) return null;
      const ctx = { transport: 'ipc' } as never;
      if (op === 'definition') return await box.handlers.definition({ projectId, file, position }, ctx);
      if (op === 'references') return await box.handlers.references({ projectId, file, position }, ctx);
      if (op === 'hover') return await box.handlers.hover({ projectId, file, position }, ctx);
      return null;
    } catch {
      return null;
    }
  });
}

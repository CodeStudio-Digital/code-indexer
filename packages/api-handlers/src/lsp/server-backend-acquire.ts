import type { CodeIndexDB } from '@mcp/store/db.js';
import type {
  LspAcquireIntent,
  LspRouteIdentity,
  LspServerManager,
} from '@mcp/services/lsp/lsp-server-manager.js';
import { ensureLspManager } from './server-backend-manager.js';

export interface LspServerTarget {
  serverId: string;
  identity?: LspRouteIdentity;
  routeId?: string;
}

const interactiveDeadline = Number(process.env.MCP_LSP_INTERACTIVE_DEADLINE_MS);
export const INTERACTIVE_LSP_ACQUIRE_DEADLINE_MS = Number.isFinite(interactiveDeadline)
  ? Math.max(0, interactiveDeadline)
  : 750;

function normalizeTarget(target?: string | LspServerTarget): LspServerTarget | undefined {
  return typeof target === 'string' ? { serverId: target } : target;
}

/** Warm a cold server without pinning an automatic RPC to its full startup. */
export async function acquireLspWithDeadline(
  db: CodeIndexDB,
  projectId: number,
  languageId: string,
  deadlineMs = INTERACTIVE_LSP_ACQUIRE_DEADLINE_MS,
  signal?: AbortSignal,
  intent: LspAcquireIntent = 'interactive',
  serverTarget?: string | LspServerTarget,
): Promise<Awaited<ReturnType<LspServerManager['acquire']>>> {
  if (signal?.aborted) return null;
  const manager = ensureLspManager(db);
  const target = normalizeTarget(serverTarget);
  const pending = target?.routeId
    ? manager.acquireByRouteId(projectId, target.routeId, intent)
    : target
      ? manager.acquireById(projectId, target.serverId, intent, target.identity)
      : manager.acquire(projectId, languageId, intent);
  const timedOut = Symbol('lsp-acquire-deadline');
  const cancelled = Symbol('lsp-acquire-cancelled');
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const contenders: Array<Promise<
    Awaited<ReturnType<LspServerManager['acquire']>> | typeof timedOut | typeof cancelled
  >> = [pending];
  if (deadlineMs > 0) {
    contenders.push(new Promise<typeof timedOut>((resolve) => {
      timer = setTimeout(() => resolve(timedOut), deadlineMs);
      timer.unref?.();
    }));
  }
  if (signal) {
    contenders.push(new Promise<typeof cancelled>((resolve) => {
      onAbort = () => resolve(cancelled);
      signal.addEventListener('abort', onAbort, { once: true });
    }));
  }
  const result = await Promise.race(contenders);
  if (timer) clearTimeout(timer);
  if (signal && onAbort) signal.removeEventListener('abort', onAbort);
  if (result === timedOut || result === cancelled) {
    void pending.catch(() => undefined);
    return null;
  }
  return result;
}

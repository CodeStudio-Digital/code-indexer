/**
 * Shared ctx-resolution helpers for the `db_*` tools: ToolContext → connection
 * scope (single project vs company linked projects) + small arg utilities.
 * Mirrors api-client/shared.ts. The PURE scope logic lives in scope.ts; this
 * layer binds it to the module-global stores and the runner context.
 */
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import { isUuid } from '@mcp/session-storage';
import type { DbConnection } from '@mcp/store/db-client-store-types.js';
import { getDbToolsSessionProjects, getDbToolsStore } from './store-binding.js';
import { pickConnection, resolveDbScope, sanitizeSlug, type ScopedConn } from './scope.js';

/** Company sessions resolve to the ROOT session id (shared project links). */
function companySessionIdOf(ctx: ToolContext): string | null {
  const orch = ctx.companyContext?.orchestrator as { effectiveSessionId?: string } | undefined;
  if (typeof orch?.effectiveSessionId === 'string' && isUuid(orch.effectiveSessionId)) {
    return orch.effectiveSessionId.toLowerCase();
  }
  const raw = ctx.companyContext?.companySessionId;
  return typeof raw === 'string' && isUuid(raw) ? raw.toLowerCase() : null;
}

export type ScopeResult =
  | { ok: true; scope: ScopedConn<DbConnection>[] }
  | { ok: false; error: string };

export function resolveToolScope(ctx: ToolContext): ScopeResult {
  const store = getDbToolsStore();
  if (!store) return { ok: false, error: 'db tools unavailable (store not wired in this process)' };
  if (ctx.companyContext) {
    const links = getDbToolsSessionProjects();
    if (!links) {
      return { ok: false, error: 'db tools unavailable (session-projects store not wired in this process)' };
    }
    const sid = companySessionIdOf(ctx);
    if (sid === null) {
      return { ok: false, error: 'db tools could not resolve the company session id' };
    }
    const connections = links.listCompanySessionProjects(sid).flatMap((p) => {
      const slug = sanitizeSlug(p.label, p.project_id);
      return store.listConnections(p.project_id).map((conn) => ({ conn, projectSlug: slug }));
    });
    return { ok: true, scope: resolveDbScope({ companySessionId: sid, connections }) };
  }
  if (ctx.projectId == null) return { ok: false, error: 'No project is bound to this session.' };
  const connections = store.listConnections(ctx.projectId).map((conn) => ({ conn }));
  return { ok: true, scope: resolveDbScope({ projectId: ctx.projectId, connections }) };
}

export function pickFromCtx(
  ctx: ToolContext,
  nameArg: unknown,
): { ok: true; value: ScopedConn<DbConnection> } | { ok: false; error: string } {
  const scoped = resolveToolScope(ctx);
  if (!scoped.ok) return scoped;
  return pickConnection(scoped.scope, nameArg);
}

/** Row cap arg: default 200, hard max 1000, floor 1. */
export function clampMaxRows(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : 200;
  return Math.max(1, Math.min(n, 1000));
}

export const CONNECTION_PARAM = {
  type: 'string',
  description:
    "Connection name from db_list ('<label>', or '<project>:<label>' in company sessions). " +
    'Optional when exactly one connection is registered.',
} as const;

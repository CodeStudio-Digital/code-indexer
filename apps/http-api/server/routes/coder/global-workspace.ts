/**
 * Global-session synthetic-workspace lifecycle.
 *
 * A global session runs as a NORMAL session over a SYNTHETIC project whose root
 * is a directory of junctions/symlinks to the linked real projects (see
 * `@mcp/code-agent/core/virtual-workspace`). This module orchestrates that
 * across the two stores (projects via `db`, sessions via `sessionStore`) + the
 * filesystem. There is no single cross-connection transaction, so create rolls
 * back best-effort on failure.
 *
 * Unions are REFCOUNTED: a synthetic project is torn down only once NO session
 * references it (so it can be reused across sessions, and the boot sweep can GC
 * orphans left by a crash).
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { globalWorkspaceDir, globalWorkspacesBaseDir } from '@mcp/shared/utils/data-paths.js';
import {
  buildGlobalWorkspace,
  cleanupGlobalWorkspace,
} from '@mcp/code-agent/core/virtual-workspace.js';
import type { CoderSession, LinkedProject } from '@mcp/code-agent/sessions/types.js';
import type { ServerDeps } from '../../deps.js';

/** A typed failure for the link-mutation helpers — the route maps `.status`. */
export class GlobalWorkspaceError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409) {
    super(message);
    this.name = 'GlobalWorkspaceError';
  }
}

export interface CreateGlobalInput {
  title: string;
  provider: string;
  model: string;
  agent?: string | null;
  /** The real linked projects (resolved name + root_path), one marked primary. */
  projects: { id: number; name: string; root_path: string; isPrimary: boolean }[];
}

/** Create a global session backed by a NEW synthetic union project (junctions). */
export function createGlobalWorkspaceSession(deps: ServerDeps, input: CreateGlobalInput): CoderSession {
  const wsId = randomUUID();
  const dir = globalWorkspaceDir(wsId);
  buildGlobalWorkspace(dir, input.projects.map((p) => ({ name: p.name, rootPath: p.root_path })));
  // Friendly label (shown in the "reuse workspace" picker) = the linked names.
  const label = input.projects.map((p) => p.name).join(' + ').slice(0, 200) || 'Global workspace';
  let syntheticId: number | null = null;
  try {
    const sp = deps.db.createProject(`__global_${wsId}`, dir, label);
    syntheticId = sp.id;
    deps.db.setProjectSynthetic(sp.id, true);
    const session = deps.sessionStore.createGlobalSession({
      project_id: sp.id,
      title: input.title,
      provider: input.provider,
      model: input.model,
      agent: input.agent ?? null,
      realProjects: input.projects.map((p) => ({ projectId: p.id, isPrimary: p.isPrimary })),
    });
    // Warm the union index now (fire-and-forget, structural-first) so the file
    // tree + search are populated before the first message.
    try { deps.projectIndexService.ensureFresh(sp.id, 'session'); } catch { /* best-effort */ }
    return session;
  } catch (e) {
    // Best-effort rollback (cross-connection → no single tx).
    try { cleanupGlobalWorkspace(dir); } catch { /* ignore */ }
    if (syntheticId != null) { try { deps.db.deleteProject(syntheticId); } catch { /* ignore */ } }
    throw e;
  }
}

/** FALLBACK only: resolve a union's links from the junctions on disk (used for
 *  legacy unions with no sibling session rows). The DB is authoritative — prefer
 *  `sessionStore.listUnionProjects`. Logs dropped/dangling links for visibility. */
function deriveLinkedProjects(deps: ServerDeps, unionRoot: string): { projectId: number; isPrimary: boolean }[] {
  const out: { projectId: number; isPrimary: boolean }[] = [];
  let entries: string[];
  try { entries = readdirSync(unionRoot); } catch { return out; }
  for (const name of entries) {
    try {
      const real = realpathSync(join(unionRoot, name));
      const proj = deps.db.getProjectByPath(real);
      if (proj && !out.some((o) => o.projectId === proj.id)) {
        out.push({ projectId: proj.id, isPrimary: out.length === 0 });
      } else if (!proj) {
        console.warn(`[global-workspace] reuse: junction '${name}' → no matching project, dropped`);
      }
    } catch {
      console.warn(`[global-workspace] reuse: junction '${name}' is dangling, dropped`);
    }
  }
  return out;
}

/**
 * Create a global session that REUSES an existing union (already indexed → no
 * re-index). The linked set + original primary come from the AUTHORITATIVE DB
 * record (a sibling session's junction rows) — never inferred from disk order —
 * and the junction dir is repaired from that record (self-heal). Disk derivation
 * is a fallback for legacy unions with no sibling rows.
 */
export function reuseGlobalWorkspaceSession(
  deps: ServerDeps,
  input: { reuseProjectId: number; title: string; provider: string; model: string; agent?: string | null },
): CoderSession {
  const union = deps.db.getProject(input.reuseProjectId);
  if (!union?.is_synthetic) throw new Error('not a virtual workspace');
  const linked = deps.sessionStore.listUnionProjects(union.id);
  const realProjects = linked.length > 0
    ? linked.map((l) => ({ projectId: l.project_id, isPrimary: l.is_primary }))
    : deriveLinkedProjects(deps, union.root_path);
  if (realProjects.length === 0) throw new Error('virtual workspace has no resolvable projects');
  // Self-heal the junction dir from the authoritative set (repairs a partial/lost dir).
  if (linked.length > 0) {
    buildGlobalWorkspace(union.root_path, linked.map((l) => ({ name: l.name, rootPath: l.root_path })));
  }
  return deps.sessionStore.createGlobalSession({
    project_id: union.id,
    title: input.title,
    provider: input.provider,
    model: input.model,
    agent: input.agent ?? null,
    realProjects,
  });
}

/**
 * Rebuild the synthetic project's junctions from the UNION of every session on
 * the workspace (`listUnionProjects`), not just this session's slice. The union
 * dir is shared + refcounted across sibling sessions, and runtime/memory already
 * resolve the set this way (`db.listUnionProjectIds`), so building the physical
 * dir from the same aggregate keeps it from flip-flopping when siblings diverge
 * (e.g. one attaches a project the other lacks). For the common 1-session union
 * this is identical to the per-session set. Idempotent — repairs a missing /
 * cleaned workspace when a global session is (re)opened, before indexing. No-op
 * for non-global / non-synthetic sessions.
 */
export function ensureGlobalWorkspaceLinks(deps: ServerDeps, session: CoderSession): void {
  if (!session.is_global) return;
  const sp = deps.db.getProject(session.project_id);
  if (!sp?.is_synthetic) return;
  const linked = deps.sessionStore.listUnionProjects(sp.id);
  if (linked.length === 0) {
    // Every linked real project was deleted — the agent would run over a stale
    // empty union. Surface it rather than silently no-op'ing.
    console.warn(`[global-workspace] session ${session.id}: no linked projects remain (all removed?)`);
    return;
  }
  buildGlobalWorkspace(sp.root_path, linked.map((l) => ({ name: l.name, rootPath: l.root_path })));
}

/**
 * Attach a real project to an existing global session's virtual workspace, then
 * rebuild the junctions + warm the union index so the new files surface in the
 * tree/search immediately. The agent itself spans the new root on its NEXT run
 * (roots/env/memory are re-read at run start). Throws `GlobalWorkspaceError` on
 * a bad session/target; the route maps the status. Returns the updated link set.
 */
export function attachProjectToGlobalSession(
  deps: ServerDeps,
  sessionId: number,
  projectId: number,
): LinkedProject[] {
  const session = deps.sessionStore.getSession(sessionId);
  if (!session) throw new GlobalWorkspaceError('session not found', 404);
  if (!session.is_global) throw new GlobalWorkspaceError('not a global session', 400);
  const sp = deps.db.getProject(session.project_id);
  if (!sp?.is_synthetic) throw new GlobalWorkspaceError('session has no virtual workspace', 400);
  const target = deps.db.getProject(projectId);
  if (!target) throw new GlobalWorkspaceError(`project ${projectId} not found`, 400);
  // A synthetic union is itself a dir of junctions — linking one would nest a
  // workspace inside a workspace (mirrors the create-time guard).
  if (target.is_synthetic) throw new GlobalWorkspaceError('a virtual workspace cannot be linked', 400);
  const current = deps.sessionStore.getSessionProjects(sessionId);
  if (current.some((p) => p.project_id === projectId)) {
    throw new GlobalWorkspaceError('project already linked', 409);
  }
  deps.sessionStore.linkSessionProject(sessionId, projectId, { isPrimary: false });
  ensureGlobalWorkspaceLinks(deps, session); // rebuild junctions from the union
  try { deps.projectIndexService.ensureFresh(session.project_id, 'session'); } catch { /* best-effort */ }
  return deps.sessionStore.getSessionProjects(sessionId);
}

/**
 * Detach a real project from a global session's virtual workspace. Refuses to
 * remove the primary (the default repo) or the last remaining project. The
 * junction is dropped only if NO session on the shared union still links the
 * project (refcount), since `ensureGlobalWorkspaceLinks` rebuilds from the union
 * aggregate. Throws `GlobalWorkspaceError`; returns the updated link set.
 */
export function detachProjectFromGlobalSession(
  deps: ServerDeps,
  sessionId: number,
  projectId: number,
): LinkedProject[] {
  const session = deps.sessionStore.getSession(sessionId);
  if (!session) throw new GlobalWorkspaceError('session not found', 404);
  if (!session.is_global) throw new GlobalWorkspaceError('not a global session', 400);
  const sp = deps.db.getProject(session.project_id);
  if (!sp?.is_synthetic) throw new GlobalWorkspaceError('session has no virtual workspace', 400);
  const current = deps.sessionStore.getSessionProjects(sessionId);
  const row = current.find((p) => p.project_id === projectId);
  if (!row) throw new GlobalWorkspaceError('project not linked', 400);
  if (row.is_primary) throw new GlobalWorkspaceError('cannot remove the primary project', 400);
  if (current.length <= 1) throw new GlobalWorkspaceError('cannot remove the last project', 400);
  deps.sessionStore.unlinkSessionProject(sessionId, projectId);
  ensureGlobalWorkspaceLinks(deps, session); // rebuild junctions from the union
  try { deps.projectIndexService.ensureFresh(session.project_id, 'session'); } catch { /* best-effort */ }
  return deps.sessionStore.getSessionProjects(sessionId);
}

/**
 * Tear down a synthetic union ONLY if no session references it (refcount). Call
 * this AFTER the session row(s) have been removed, so the count is accurate.
 * SAFE: `cleanupGlobalWorkspace` only unlinks the junctions, never real files.
 */
export function teardownGlobalWorkspaceIfOrphan(deps: ServerDeps, syntheticProjectId: number): void {
  const sp = deps.db.getProject(syntheticProjectId);
  if (!sp?.is_synthetic) return;
  if (deps.sessionStore.countSessionsForProject(sp.id) > 0) return; // still in use
  try { cleanupGlobalWorkspace(sp.root_path); } catch { /* ignore */ }
  try { deps.db.deleteProject(sp.id); } catch { /* ignore */ }
}

/**
 * Boot sweep: GC orphan virtual workspaces left by a crash or an uncovered
 * delete path — (1) synthetic projects with zero sessions, and (2) directories
 * under `global-workspaces/` with no synthetic project row. Returns a count for
 * the boot log. SAFE: only unlinks junctions, never real files.
 */
export function sweepOrphanGlobalWorkspaces(deps: ServerDeps): number {
  let removed = 0;
  const liveDirs = new Set<string>();
  for (const sp of deps.db.listSyntheticProjects()) {
    liveDirs.add(sp.root_path);
    if (deps.sessionStore.countSessionsForProject(sp.id) === 0) {
      try { cleanupGlobalWorkspace(sp.root_path); } catch { /* ignore */ }
      try { deps.db.deleteProject(sp.id); } catch { /* ignore */ }
      liveDirs.delete(sp.root_path);
      removed++;
    }
  }
  // GC loose ad-hoc folders (mig 176) that no global session references anymore
  // (neither as a junction member nor as a session's own project_id). They were
  // registered transparently when the user started a global session from an
  // arbitrary path; once that session is gone the hidden row is dead weight.
  // SAFE: `deleteProject` only drops DB metadata — the real folder on disk is
  // never touched (loose folders are indexed via the synthetic junction, not
  // standalone). Done AFTER the synthetic sweep so unions are torn down first.
  for (const lp of deps.db.listOrphanLooseProjects()) {
    try { deps.db.deleteProject(lp.id); removed++; } catch { /* ignore */ }
  }

  // Stray dirs with no synthetic project row (e.g. crash between mkdir + createProject).
  let dirs: string[];
  try { dirs = readdirSync(globalWorkspacesBaseDir()); } catch { return removed; }
  for (const name of dirs) {
    const dir = join(globalWorkspacesBaseDir(), name);
    if (!liveDirs.has(dir)) {
      try { cleanupGlobalWorkspace(dir); removed++; } catch { /* ignore */ }
    }
  }
  return removed;
}

/**
 * Handlers do Local History (mig 160) — separados de index.ts para não inflá-lo.
 * Restore é NÃO-destrutivo: captura o estado atual do disco antes de sobrescrever
 * (vira uma nova revisão 'save'), então a timeline fica append-only.
 */
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { ApiError, type FilesApi, type HistoryRevision } from '@mcp/api-bus';
import type { HistoryRevisionRow } from '@mcp/store/file-local-history-store.js';
import type { HandlerDeps } from '../types.js';
import { resolveSafe } from './index.js';
import { captureLocalHistory } from './local-history.js';

type HistoryHandlers = Pick<FilesApi, 'historyList' | 'historyGet' | 'historyRestore' | 'historyLabel'>;

function toDTO(r: HistoryRevisionRow): HistoryRevision {
  return {
    id: r.id,
    path: r.path,
    content_hash: r.content_hash,
    size: r.size,
    kind: r.kind,
    label: r.label,
    existed_before: r.existed_before,
    oversized: r.oversized,
    created_at: r.created_at,
  };
}

export function createHistoryHandlers(deps: HandlerDeps): HistoryHandlers {
  const { db, fileLocalHistoryStore: store } = deps;

  function requireProject(projectId: number) {
    const p = db.getProject(projectId);
    if (!p) throw new ApiError('not_found', 404, 'project not found');
    return p;
  }
  /** Revisão que pertence ao projeto (defesa-em-profundidade contra id forjado). */
  function requireRev(projectId: number, id: number): HistoryRevisionRow {
    const rev = store.getRevision(id);
    if (!rev || rev.project_id !== projectId) throw new ApiError('not_found', 404, 'revision not found');
    return rev;
  }

  return {
    async historyList({ projectId, path: rel }) {
      requireProject(projectId);
      return { revisions: store.listRevisions(projectId, rel.replace(/\\/g, '/')).map(toDTO) };
    },

    async historyGet({ projectId, id }) {
      requireProject(projectId);
      const rev = requireRev(projectId, id);
      return { rev: toDTO(rev), content: store.getRevisionContent(id) };
    },

    async historyRestore({ projectId, id }) {
      const project = requireProject(projectId);
      const rev = requireRev(projectId, id);
      if (rev.oversized) throw new ApiError('revision_oversized', 409, 'revision too large/binary — not restorable');
      const abs = resolveSafe(project.root_path, rev.path);

      // Captura o estado atual ANTES de mexer → restore reversível.
      await captureLocalHistory(deps, projectId, rev.path, { kind: 'save', readFrom: abs });

      const relPosix = rev.path.replace(/\\/g, '/');
      if (rev.existed_before === 0) {
        // A versão é "o arquivo não existia" → restaurar = apagar.
        await fs.rm(abs, { force: true });
        deps.projectIndexService.markDirty(projectId, [{ path: relPosix, kind: 'delete' }]);
        return { ok: true as const, last_modified: null, deleted: true as const };
      }

      const content = store.getRevisionContent(id);
      if (content == null) throw new ApiError('revision_unavailable', 409, 'revision content unavailable');
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, content, 'utf8');
      const stat = await fs.stat(abs);
      deps.projectIndexService.markDirty(projectId, [{ path: relPosix, kind: 'upsert' }]);
      return { ok: true as const, last_modified: stat.mtime.toISOString() };
    },

    async historyLabel({ projectId, id, label }) {
      requireProject(projectId);
      requireRev(projectId, id);
      store.labelRevision(id, label);
      return { ok: true as const };
    },
  };
}

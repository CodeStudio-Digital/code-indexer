/**
 * Handlers for the `search` namespace — hybrid (FTS5 + vector) over the
 * indexed codebase. Wraps `hybridSearch` (the deps singleton) with the
 * same shape the existing /api/projects/:id/search endpoint exposes.
 */

import { ApiError, type SearchApi } from '@mcp/api-bus';
import type { SearchMode, SearchType } from '@mcp/shared/types.js';
import type { HandlerDeps } from '../types.js';

export function createSearchHandlers(deps: HandlerDeps): SearchApi {
  const { db, hybridSearch } = deps;

  return {
    async project({ projectId, query, mode, type, limit }) {
      const project = db.getProject(projectId);
      if (!project) throw new ApiError('not_found', 404, 'project not found');
      const effectiveMode = (mode ?? project.search_mode ?? 'hybrid') as SearchMode;
      const { results, diagnostics } = await hybridSearch.searchWithDiag(
        projectId,
        project.name,
        query,
        {
          mode: effectiveMode,
          type: (type ?? 'all') as SearchType,
          limit: limit ?? 20,
        },
      );
      return { results: results as never, diagnostics: diagnostics as never };
    },

    async global({ query, limit }) {
      const cap = limit ?? 20;
      const projects = db.listProjects();
      const allResults: Array<Record<string, unknown> & { score: number; project: string }> = [];
      for (const p of projects) {
        const results = await hybridSearch.search(p.id, p.name, query, { limit: cap });
        allResults.push(
          ...results.map((r) => ({ ...(r as object), project: p.name } as never)),
        );
      }
      allResults.sort((a, b) => b.score - a.score);
      return allResults.slice(0, cap) as never;
    },
  };
}

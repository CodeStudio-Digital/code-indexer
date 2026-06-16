/**
 * Handlers for the `search` namespace — hybrid (FTS5 + vector) over the
 * indexed codebase. Wraps `hybridSearch` (the deps singleton) with the
 * same shape the existing /api/projects/:id/search endpoint exposes.
 */

import { ApiError, type SearchApi, type SymbolHit } from '@mcp/api-bus';
import { buildContentMatchQuery } from '@mcp/indexer/search/content-grep.js';
import type { SearchMode, SearchType } from '@mcp/shared/types.js';
import type { HandlerDeps } from '../types.js';
import { grepProject } from './text-grep.js';
import { replaceInProject } from './text-replace.js';

/** Tokens → FTS5 prefix-AND (`tok1* AND tok2*`), or null when unusable. */
function ftsPrefixQuery(query: string): string | null {
  const tokens = (query.match(/[A-Za-z0-9_]+/g) ?? [])
    .flatMap((t) => t.split(/_+/))
    .filter((t) => t.length >= 2)
    .slice(0, 6);
  if (tokens.length === 0) return null;
  return tokens.map((t) => `${t.toLowerCase()}*`).join(' AND ');
}

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

    async symbols({ projectId, query, limit }) {
      if (!db.getProject(projectId)) throw new ApiError('not_found', 404, 'project not found');
      const cap = limit ?? 50;
      const trimmed = query.trim();
      if (!trimmed) return [];
      const out = new Map<string, SymbolHit>();
      const push = (s: { name: string; kind: string; file_path: string; line: number | null; col: number | null; signature: string; exported: number }) => {
        const k = `${s.file_path}:${s.line}:${s.name}`;
        if (!out.has(k)) out.set(k, {
          name: s.name, kind: s.kind, file_path: s.file_path,
          line: s.line, col: s.col, signature: s.signature, exported: s.exported,
        });
      };
      // Exact-prefix b-tree first (camelCase-safe), then FTS prefix-AND
      // (matches snake_case parts + signature/comment words).
      for (const s of db.searchSymbolsByPrefix(projectId, trimmed, cap)) push(s);
      const fts = ftsPrefixQuery(trimmed);
      if (fts && out.size < cap) {
        try {
          for (const s of db.searchSymbols(projectId, fts, cap)) push(s);
        } catch { /* malformed MATCH — prefix results stand */ }
      }
      return [...out.values()].slice(0, cap);
    },

    async text({ projectId, query, limit }) {
      if (!db.getProject(projectId)) throw new ApiError('not_found', 404, 'project not found');
      const match = buildContentMatchQuery(query.trim(), true);
      if (!match) return [];
      try {
        return db.searchFileContents(projectId, match, limit ?? 50).map((m) => ({ path: m.path }));
      } catch {
        return []; // pre-migration DB without the contents vtab
      }
    },

    async grep(input) {
      if (!db.getProject(input.projectId)) throw new ApiError('not_found', 404, 'project not found');
      return grepProject(db, input.projectId, input);
    },

    async replace(input) {
      if (!db.getProject(input.projectId)) throw new ApiError('not_found', 404, 'project not found');
      const idx = deps.projectIndexService;
      const markDirty = idx
        ? (pid: number, changes: Array<{ path: string; kind: 'upsert' }>) => idx.markDirty(pid, changes)
        : undefined;
      return replaceInProject(db, markDirty, input.projectId, input);
    },
  };
}

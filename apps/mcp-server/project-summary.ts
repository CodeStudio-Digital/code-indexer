import type { Project } from '@mcp/shared/types.js';
import { codeNamespace } from '@mcp/shared/vector-namespace.js';
import type { ToolContext } from './context.js';

/** Shared structural + semantic snapshot for MCP tools and resources.
 * It intentionally reads none of the retired per-file LLM enrichment fields
 * (`summary`, `concepts`, `layer`, `complexity`). */
export function buildProjectSummary(ctx: ToolContext, project: Project) {
  ctx.signal?.throwIfAborted();
  const stats = ctx.db.getStats(project.id);
  const shape = ctx.db.getAgentProjectShape(project.id);
  const namespace = codeNamespace(project.id);
  const generation = ctx.semanticStore.listNamespaceGenerations({ namespace })[0] ?? null;
  const target = ctx.semanticStore.getProfile('code')?.embedding_target.kind ?? 'disabled';
  const semanticState = target === 'disabled'
    ? 'disabled'
    : generation?.last_error
      ? 'error'
      : generation?.active_generation_id
        ? generation.delta_items > 0 ? 'updating' : 'active'
        : generation?.building_generation_id
          ? 'building'
          : 'not_indexed';
  const coveragePct = generation && generation.expected_items > 0
    ? Math.round((generation.indexed_items / generation.expected_items) * 100)
    : 0;
  ctx.signal?.throwIfAborted();

  return {
    project: project.name,
    root_path: project.root_path,
    file_count: stats.file_count,
    symbol_count: stats.symbol_count,
    total_lines: stats.total_lines,
    languages: stats.languages,
    top_directories: shape.topDirectories,
    key_files: shape.keyFiles,
    structural: {
      state: project.structural_indexed_at || stats.file_count > 0 ? 'ready' : 'missing',
      indexed_at: project.structural_indexed_at ?? null,
      last_checked_at: project.structural_last_checked_at ?? null,
    },
    semantic: {
      namespace,
      state: semanticState,
      active_generation_id: generation?.active_generation_id ?? null,
      building_generation_id: generation?.building_generation_id ?? null,
      expected_items: generation?.expected_items ?? 0,
      indexed_items: generation?.indexed_items ?? 0,
      coverage_pct: coveragePct,
      pending_delta_items: generation?.delta_items ?? 0,
      failed_items: generation?.failed_items ?? 0,
      error: generation?.last_error ?? null,
      target,
    },
    snapshots_count: ctx.db.countSnapshots(project.id),
  };
}

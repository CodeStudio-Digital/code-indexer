import type { Project } from '@mcp/shared/types.js';
import { codeNamespace } from '@mcp/shared/vector-namespace.js';
import type { ToolContext } from './context.js';

function topDirectories(paths: readonly string[], limit = 8): Array<{ path: string; files: number }> {
  const counts = new Map<string, number>();
  for (const path of paths) {
    const normalized = path.replace(/\\/g, '/');
    const slash = normalized.indexOf('/');
    const directory = slash < 0 ? '.' : normalized.slice(0, slash);
    counts.set(directory, (counts.get(directory) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([path, files]) => ({ path, files }))
    .sort((left, right) => right.files - left.files || left.path.localeCompare(right.path))
    .slice(0, limit);
}

function keyFiles(paths: readonly string[], limit = 8): string[] {
  const manifest = /(^|\/)(?:package\.json|pyproject\.toml|cargo\.toml|go\.mod|pom\.xml|build\.gradle(?:\.kts)?|readme(?:\.[^/]+)?)$/i;
  const entryLike = /(^|\/)(?:index|main|app|server|cli)\.[^/]+$/i;
  return [...paths]
    .sort((left, right) => {
      const leftRank = manifest.test(left) ? 0 : entryLike.test(left) ? 1 : 2;
      const rightRank = manifest.test(right) ? 0 : entryLike.test(right) ? 1 : 2;
      return leftRank - rightRank
        || left.split('/').length - right.split('/').length
        || left.localeCompare(right);
    })
    .slice(0, limit);
}

/** Shared structural + semantic snapshot for MCP tools and resources.
 * It intentionally reads none of the retired per-file LLM enrichment fields
 * (`summary`, `concepts`, `layer`, `complexity`). */
export function buildProjectSummary(ctx: ToolContext, project: Project) {
  const stats = ctx.db.getStats(project.id);
  const files = ctx.db.listFiles(project.id);
  const paths = files.map((file) => file.path);
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

  return {
    project: project.name,
    root_path: project.root_path,
    file_count: stats.file_count,
    symbol_count: stats.symbol_count,
    total_lines: stats.total_lines,
    languages: stats.languages,
    top_directories: topDirectories(paths),
    key_files: keyFiles(paths),
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
    snapshots_count: ctx.db.listSnapshots(project.id).length,
  };
}

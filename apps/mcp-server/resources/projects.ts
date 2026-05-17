import { defineResource, type McpResource, type ResourceContent, type ListedResource } from '../resource.js';
import type { ToolContext } from '../context.js';
import { buildRepoMap } from '@mcp/services/services/repo-map.js';

/**
 * URI matchers for the two project-scoped resources. Strict on purpose: the
 * aggregate `read` handler iterates resources in order and asks each one to
 * try matching, so a mismatched template returns null and the next resource
 * gets a turn. Use anchored regexes here so neighbour endpoints (a future
 * `/files`, `/symbols`, ...) don't accidentally collide.
 */
const OVERVIEW_URI = /^mcp:\/\/project\/([^/]+)\/overview$/;
const REPO_MAP_URI = /^mcp:\/\/project\/([^/]+)\/repo-map$/;

/**
 * List indexed projects. Both project resources share this — we surface a
 * resource entry only when the project has at least one indexed file. An
 * empty / never-indexed project has no overview worth exposing.
 */
function listIndexedProjects(ctx: ToolContext): Array<{ name: string; fileCount: number }> {
  return ctx.db.listProjects()
    .map((p) => ({ name: p.name, fileCount: ctx.db.listFiles(p.id).length }))
    .filter((p) => p.fileCount > 0);
}

/**
 * `mcp://project/{name}/overview` — JSON snapshot of project health,
 * mirroring the `get_project_pulse` tool's `format=json` output. Kept inline
 * (not refactored into a shared helper) because the resource only needs the
 * JSON shape and the tool's text-mode formatting is irrelevant here.
 */
const projectOverview = defineResource({
  uriTemplate: 'mcp://project/{project_name}/overview',
  name: 'project_overview',
  description:
    'Compact JSON snapshot of an indexed project (file count, languages, layers, top concepts, snapshots, vector coverage, cost). One per indexed project. Mirrors the get_project_pulse tool (format=json).',
  mimeType: 'application/json',
  async list(ctx: ToolContext): Promise<ListedResource[]> {
    return listIndexedProjects(ctx).map(({ name, fileCount }) => ({
      uri: `mcp://project/${encodeURIComponent(name)}/overview`,
      name: `${name} overview`,
      description: `Compact pulse for project '${name}' (${fileCount} files indexed).`,
      mimeType: 'application/json',
    }));
  },
  async read(uri: string, ctx: ToolContext): Promise<ResourceContent[] | null> {
    const match = OVERVIEW_URI.exec(uri);
    if (!match) return null;
    const projectName = safeDecode(match[1]);
    const project = ctx.db.listProjects().find((p) => p.name === projectName);
    if (!project) return null;

    const stats = ctx.db.getStats(project.id);
    const arch = ctx.db.getArchitectureOverview(project.id);
    const files = ctx.db.listFiles(project.id);
    const conceptCount = new Map<string, number>();
    const entryPoints: string[] = [];
    for (const f of files) {
      if (f.is_entry_point) entryPoints.push(f.path);
      try {
        const cs = JSON.parse(f.concepts || '[]') as string[];
        for (const c of cs) conceptCount.set(c, (conceptCount.get(c) ?? 0) + 1);
      } catch {
        /* ignore malformed concepts JSON */
      }
    }
    const topConcepts = [...conceptCount.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([c]) => c);
    const snaps = ctx.db.listSnapshots(project.id);
    const costs = ctx.db.getCostSummary(project.id);
    const cov = ctx.db.getEmbeddingCoverage(project.id);
    const filePct = cov.files_total > 0 ? Math.round((cov.files_embedded / cov.files_total) * 100) : 0;
    const symPct = cov.symbols_total > 0 ? Math.round((cov.symbols_embedded / cov.symbols_total) * 100) : 0;
    const bodyPct =
      cov.symbol_bodies_total > 0 ? Math.round((cov.symbol_bodies_embedded / cov.symbol_bodies_total) * 100) : 0;

    const payload = {
      project: project.name,
      file_count: stats.file_count,
      symbol_count: stats.symbol_count,
      total_lines: stats.total_lines,
      last_indexed: stats.last_indexed ?? null,
      languages: stats.languages,
      layers: arch,
      top_concepts: topConcepts,
      entry_points: entryPoints.slice(0, 5),
      snapshots_count: snaps.length,
      vector_coverage: {
        files_pct: filePct,
        symbols_pct: symPct,
        bodies_pct: bodyPct,
      },
      cost: {
        total_usd: costs.total_cost_usd,
        llm_analysis_usd: costs.llm_analysis_cost_usd,
        embedding_usd: costs.embedding_cost_usd,
      },
    };
    return [{ type: 'text', text: JSON.stringify(payload, null, 2), mimeType: 'application/json' }];
  },
});

/**
 * `mcp://project/{name}/repo-map` — Aider-style structural map. Reuses the
 * exact builder the `get_repo_map` tool uses so output stays consistent
 * across both surfaces.
 */
const projectRepoMap = defineResource({
  uriTemplate: 'mcp://project/{project_name}/repo-map',
  name: 'repo_map',
  description:
    'Aider-style structural map of a project (~2000 tokens) — file tree annotated with key symbols, weighted by importance. One per indexed project. Mirrors the get_repo_map tool.',
  mimeType: 'text/markdown',
  async list(ctx: ToolContext): Promise<ListedResource[]> {
    return listIndexedProjects(ctx).map(({ name, fileCount }) => ({
      uri: `mcp://project/${encodeURIComponent(name)}/repo-map`,
      name: `${name} repo map`,
      description: `Structural map for project '${name}' (${fileCount} files).`,
      mimeType: 'text/markdown',
    }));
  },
  async read(uri: string, ctx: ToolContext): Promise<ResourceContent[] | null> {
    const match = REPO_MAP_URI.exec(uri);
    if (!match) return null;
    const projectName = safeDecode(match[1]);
    const project = ctx.db.listProjects().find((p) => p.name === projectName);
    if (!project) return null;
    const text = buildRepoMap(ctx.db, project.id);
    return [{ type: 'text', text, mimeType: 'text/markdown' }];
  },
});

/** Decode a URI segment without throwing on malformed input. */
function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export const projectResources: McpResource[] = [projectOverview, projectRepoMap];

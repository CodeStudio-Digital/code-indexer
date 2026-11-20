import { defineResource, type McpResource, type ResourceContent, type ListedResource } from '../resource.js';
import type { ToolContext } from '../context.js';
import { buildRepoMap } from '@mcp/services/services/repo-map.js';
import { buildProjectSummary } from '@mcp/indexer/agent-tools/project-summary.js';

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
    .map((p) => ({ name: p.name, fileCount: ctx.db.countFiles(p.id) }))
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
    'Compact JSON snapshot of a project: structural coverage, files, symbols, languages, semantic generation and snapshots. One per indexed project. Mirrors get_project_pulse with format=json.',
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

    const payload = buildProjectSummary(ctx, project);
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

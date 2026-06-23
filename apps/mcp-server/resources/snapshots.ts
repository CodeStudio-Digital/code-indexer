import { defineResource, type McpResource, type ResourceContent, type ListedResource } from '../resource.js';
import type { ToolContext } from '../context.js';

/**
 * Snapshots are exposed as a template-only resource: `resources/list` does
 * not enumerate every snapshot in every project (a busy server may have
 * thousands), but clients can construct the URI from a known id — obtained
 * via the existing `list_snapshots` / `query_snapshots` tools — and read on
 * demand via `resources/read`.
 *
 * The template is published through `resources/templates/list` so MCP-aware
 * clients (Claude Desktop, IDEs) can offer a "type a snapshot id" picker.
 */

const SNAPSHOT_URI = /^mcp:\/\/snapshot\/([^/]+)\/(\d+)$/;

const snapshot = defineResource({
  uriTemplate: 'mcp://snapshot/{project_name}/{snapshot_id}',
  name: 'snapshot',
  description:
    'A single context snapshot (title, category, content, tags, referenced files, staleness). Template-only — clients construct the URI from a snapshot id obtained via list_snapshots or query_snapshots.',
  mimeType: 'application/json',
  async list(): Promise<ListedResource[]> {
    // Intentionally empty: see header comment. Listing every snapshot
    // scales poorly and clients have efficient discovery via the snapshot
    // tools.
    return [];
  },
  async read(uri: string, ctx: ToolContext): Promise<ResourceContent[] | null> {
    const match = SNAPSHOT_URI.exec(uri);
    if (!match) return null;
    const projectName = safeDecode(match[1]);
    const id = Number(match[2]);
    if (!Number.isFinite(id) || id <= 0) return null;

    const snap = ctx.db.getSnapshotById(id);
    if (!snap) return null;

    // Cross-check the project — a leaked id from another project should not
    // be readable just because the numeric id happens to exist.
    const project = ctx.db.listProjects().find((p) => p.name === projectName);
    if (!project || snap.project_id !== project.id) return null;

    const referencedFiles = ctx.db.getSnapshotFiles(snap.id);
    const payload = {
      id: snap.id,
      project: project.name,
      title: snap.title,
      category: snap.category,
      content: snap.content,
      tags: parseJsonArray(snap.tags),
      referenced_files: referencedFiles,
      created_at: snap.created_at,
      updated_at: snap.updated_at,
      created_by: snap.created_by,
    };
    return [{ type: 'text', text: JSON.stringify(payload, null, 2), mimeType: 'application/json' }];
  },
});

function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export const snapshotResources: McpResource[] = [snapshot];

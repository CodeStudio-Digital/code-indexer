import { defineTool, type McpTool } from '../tool.js';
import { truncateToTokens } from '../utils.js';
import type { SnapshotCategory } from '@mcp/shared/types.js';
import { SnapshotService } from '@mcp/services/services/snapshots.js';
import { withProject, type ProjectToolHandler } from './_helpers.js';

/**
 * Wrap a snapshot tool handler so any thrown error becomes a structured
 * response instead of a raw stack trace at the MCP layer. JSON callers get
 * `{ error: "..." }`, text callers get `Snapshot operation failed: ...`.
 *
 * Stays inside this file on purpose — the surrounding tool catalogue does
 * its own error mapping, so a generic wrapper would overreach.
 */
function withSnapshotErrorHandling(
  handler: ProjectToolHandler,
): ProjectToolHandler {
  return async (args, ctx, project, authCtx) => {
    try {
      return await handler(args, ctx, project, authCtx);
    } catch (err) {
      const message = (err as Error).message ?? String(err);
      if (args.format === 'json') {
        return JSON.stringify({ error: message });
      }
      return `Snapshot operation failed: ${message}`;
    }
  };
}

/** Shorten an embed error so it fits inside the success-with-warning line. */
function summarizeEmbedError(err: string | undefined): string | null {
  if (!err) return null;
  return err.length > 140 ? err.slice(0, 137) + '...' : err;
}

const add_snapshot = defineTool({
  name: 'add_snapshot',
  description: 'Add a context snapshot. Pass referenced_files to track files the snapshot depends on; the snapshot will be marked STALE when those files change. The snapshot is also embedded for semantic retrieval via query_snapshots / get_project_context.',
  inputSchema: {
    type: 'object',
    properties: {
      project_name: { type: 'string' },
      title: { type: 'string' },
      category: { type: 'string', enum: ['architecture', 'decision', 'pattern', 'convention', 'todo', 'note', 'gotcha', 'procedure'] },
      content: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
      referenced_files: {
        type: 'array',
        items: { type: 'string' },
        description: 'Project-relative file paths this snapshot depends on; used for staleness detection',
      },
    },
    required: ['project_name', 'title', 'category', 'content'],
  },
  handler: withProject(withSnapshotErrorHandling(async (args, { snapshotService }, project, authCtx) => {
    const result = await snapshotService.create(project.id, {
      title: args.title as string,
      category: args.category as SnapshotCategory,
      content: args.content as string,
      tags: args.tags as string[] | undefined,
      referencedFiles: args.referenced_files as string[] | undefined,
      createdBy: authCtx?.principal ?? 'mcp',
    });
    const refCount = (args.referenced_files as string[] | undefined)?.length ?? 0;
    const trackedCount = refCount - (result.skippedFiles?.length ?? 0);
    const refNote = trackedCount > 0
      ? ` (tracking ${trackedCount} referenced file${trackedCount === 1 ? '' : 's'} for staleness)`
      : '';
    const skippedNote = result.skippedFiles && result.skippedFiles.length > 0
      ? ` (warning: ${result.skippedFiles.length} file(s) not yet indexed — skipped: ${result.skippedFiles.join(', ')})`
      : '';
    const embed = summarizeEmbedError(result.embedError);
    const embedNote = embed ? ` (warning: vector index failed — pending backfill: ${embed})` : '';
    return `Snapshot #${result.snap.id} "${result.snap.title}" created.${refNote}${skippedNote}${embedNote}`;
  })),
});

const list_snapshots = defineTool({
  name: 'list_snapshots',
  description: 'List context snapshots (compact by default — set compact=false for full content)',
  inputSchema: {
    type: 'object',
    properties: {
      project_name: { type: 'string' },
      category: { type: 'string' },
      compact: { type: 'boolean' },
      max_tokens: { type: 'number' },
    },
    required: ['project_name'],
  },
  handler: withProject(withSnapshotErrorHandling((args, { snapshotService }, project) => {
    const list = snapshotService.list(project.id, args.category as SnapshotCategory | undefined);
    const annotated = snapshotService.annotateStaleMany(project.id, list);
    const compact = args.compact !== false;
    if (annotated.length === 0) return 'No snapshots.';
    const staleTag = (s: typeof annotated[number]) => s.stale ? ' [STALE]' : '';
    if (compact) {
      const out = annotated.map(s => `#${s.id} [${s.category}]${staleTag(s)} ${s.title} — ${s.content.replace(/\s+/g, ' ').slice(0, 120)}`).join('\n');
      return truncateToTokens(out, args.max_tokens as number | undefined);
    }
    const out = annotated.map(s => {
      const tags = (() => { try { return JSON.parse(s.tags).join(', '); } catch { return ''; } })();
      const staleLine = s.stale ? `STALE — diverged files: ${(s.stale_files ?? []).join(', ')}` : '';
      return [
        `## #${s.id} [${s.category}]${staleTag(s)} ${s.title}`,
        `Created: ${s.created_at} by ${s.created_by}${tags ? ` | Tags: ${tags}` : ''}`,
        staleLine,
        '',
        s.content,
      ].filter(Boolean).join('\n');
    }).join('\n\n---\n\n');
    return truncateToTokens(out, args.max_tokens as number | undefined);
  })),
});

const update_snapshot = defineTool({
  name: 'update_snapshot',
  description: 'Update a snapshot. Pass referenced_files to replace the file references tracked for staleness. Editing title or content invalidates the cached embedding so the next access re-embeds.',
  inputSchema: {
    type: 'object',
    properties: {
      project_name: { type: 'string' },
      snapshot_id: { type: 'number' },
      title: { type: 'string' },
      category: { type: 'string', enum: ['architecture', 'decision', 'pattern', 'convention', 'todo', 'note', 'gotcha', 'procedure'] },
      content: { type: 'string' },
      tags: { type: 'array', items: { type: 'string' } },
      referenced_files: { type: 'array', items: { type: 'string' } },
    },
    required: ['project_name', 'snapshot_id'],
  },
  handler: withProject(withSnapshotErrorHandling(async (args, { snapshotService }, project, authCtx) => {
    const result = await snapshotService.update(args.snapshot_id as number, {
      title: args.title as string | undefined,
      category: args.category as SnapshotCategory | undefined,
      content: args.content as string | undefined,
      tags: args.tags as string[] | undefined,
      referencedFiles: args.referenced_files as string[] | undefined,
      projectId: project.id,
      updatedBy: authCtx?.principal ?? 'mcp',
    });
    const skippedNote = result.skippedFiles && result.skippedFiles.length > 0
      ? ` (warning: ${result.skippedFiles.length} file(s) not yet indexed — skipped: ${result.skippedFiles.join(', ')})`
      : '';
    const embed = summarizeEmbedError(result.embedError);
    const embedNote = embed ? ` (warning: vector index failed — pending backfill: ${embed})` : '';
    return `Snapshot #${args.snapshot_id} updated.${skippedNote}${embedNote}`;
  })),
});

const delete_snapshot = defineTool({
  name: 'delete_snapshot',
  description: 'Delete a snapshot',
  inputSchema: {
    type: 'object',
    properties: { snapshot_id: { type: 'number' } },
    required: ['snapshot_id'],
  },
  handler: (args, { snapshotService }) => {
    try {
      snapshotService.delete(args.snapshot_id as number);
      return `Snapshot #${args.snapshot_id} deleted.`;
    } catch (err) {
      return `Snapshot operation failed: ${(err as Error).message}`;
    }
  },
});

const get_snapshot_history = defineTool({
  name: 'get_snapshot_history',
  description: 'Get version history of a snapshot',
  inputSchema: {
    type: 'object',
    properties: { snapshot_id: { type: 'number' } },
    required: ['snapshot_id'],
  },
  handler: (args, { snapshotService }) => {
    try {
      const history = snapshotService.getHistory(args.snapshot_id as number);
      return history.map(v => [
        `## Version ${v.version} — ${v.updated_at} by ${v.updated_by}`,
        `Title: ${v.title} [${v.category}]`,
        '',
        v.content,
      ].join('\n')).join('\n\n---\n\n') || 'No version history.';
    } catch (err) {
      return `Snapshot operation failed: ${(err as Error).message}`;
    }
  },
});

const get_project_context = defineTool({
  name: 'get_project_context',
  description: 'Curated semantic context for a question. Provide `query` and the tool returns the most relevant snapshots ranked by hybrid (FTS + vector) search, grouped by category. Replaces the previous behaviour that dumped every snapshot.',
  inputSchema: {
    type: 'object',
    properties: {
      project_name: { type: 'string' },
      query: { type: 'string', description: 'Natural-language question. The hybrid search ranks snapshots by relevance.' },
      limit: { type: 'number', description: 'Max snapshots to include in the rendered bundle. Default 10.' },
      max_tokens: { type: 'number' },
    },
    required: ['project_name', 'query'],
  },
  handler: withProject(withSnapshotErrorHandling(async (args, { db, snapshotService, hybridSearch }, project) => {
    const query = (args.query as string).trim();
    if (!query) {
      return 'get_project_context requires a non-empty query. Pass `query` describing the topic you want context on.';
    }
    const limit = (args.limit as number) ?? 10;
    const ranked = await hybridSearch.searchSnapshotsHybrid(project.id, project.name, query, limit);
    if (ranked.length === 0) {
      const total = db.countSnapshots(project.id);
      if (total === 0) {
        return 'This project has no snapshots yet. Use add_snapshot, or run the indexer to auto-generate context snapshots.';
      }
      return `No snapshots matched "${query}" (${total} snapshot(s) exist). Try broader terms or use list_snapshots to browse.`;
    }
    const annotated = snapshotService.annotateStaleMany(project.id, ranked);
    const rendered = SnapshotService.renderGrouped(
      annotated,
      `# Context for: "${query}"`,
    );
    return truncateToTokens(rendered, args.max_tokens as number | undefined);
  })),
});

const query_snapshots = defineTool({
  name: 'query_snapshots',
  description: 'Hybrid (FTS + vector RRF) search over project snapshots. Try this BEFORE exploring code — many questions are already answered in auto-snapshots. Results include a stale flag when referenced files have changed since the snapshot was created. Pass format="json" for a structured response.',
  inputSchema: {
    type: 'object',
    properties: {
      project_name: { type: 'string' },
      query: { type: 'string' },
      limit: { type: 'number' },
      compact: { type: 'boolean' },
      max_tokens: { type: 'number' },
      format: { type: 'string', enum: ['text', 'json'] },
    },
    required: ['project_name', 'query'],
  },
  handler: withProject(withSnapshotErrorHandling(async (args, { db, snapshotService, hybridSearch }, project) => {
    const query = args.query as string;
    const limit = (args.limit as number) ?? 5;
    const compact = args.compact !== false;
    const asJson = args.format === 'json';
    // Hybrid (FTS + vector RRF) so semantic matches surface even when the
    // user's phrasing doesn't contain the snapshot's keywords.
    const raw = await hybridSearch.searchSnapshotsHybrid(project.id, project.name, query, limit);
    if (raw.length === 0) {
      // Distinguish "project has no snapshots" from "query didn't match any".
      const total = db.countSnapshots(project.id);
      const detail = total === 0
        ? 'This project has no snapshots yet. Use add_snapshot to create one, or index the project first.'
        : `No snapshots matched "${query}" (${total} snapshots exist). Try broader terms.`;
      return asJson ? JSON.stringify({ query, total: 0, results: [], detail }) : detail;
    }
    const results = snapshotService.annotateStaleMany(project.id, raw);
    if (asJson) {
      return JSON.stringify({
        query,
        total: results.length,
        results: results.map(s => ({
          id: s.id,
          title: s.title,
          category: s.category,
          content: s.content,
          stale: s.stale ?? false,
          stale_files: s.stale_files ?? [],
          created_at: s.created_at,
        })),
      });
    }
    const perSnapChars = compact ? 600 : 4000;
    const out = results.map(s => {
      const staleTag = s.stale ? ' [STALE]' : '';
      const staleNote = s.stale ? `\n(stale — diverged files: ${(s.stale_files ?? []).join(', ')})` : '';
      const body = s.content.length > perSnapChars ? s.content.slice(0, perSnapChars) + '...' : s.content;
      return `## ${s.title} [${s.category}]${staleTag}${staleNote}\n${body}`;
    }).join('\n\n---\n\n');
    return truncateToTokens(out, args.max_tokens as number | undefined);
  })),
});

const get_context_for = defineTool({
  name: 'get_context_for',
  description: 'Natural-language question → curated context bundle (snapshots + top files + top symbols). Use for exploratory "how does X work?" questions. Pass hyde=true to enable HyDE query expansion (LLM-generated when a provider is configured, otherwise template-based).',
  inputSchema: {
    type: 'object',
    properties: {
      project_name: { type: 'string' },
      question: { type: 'string' },
      max_tokens: { type: 'number' },
      hyde: { type: 'boolean', description: 'Enable HyDE query expansion. When a default LLM provider is configured the query is expanded via a one-shot call that drafts a hypothetical code snippet; otherwise falls back to template-based variants. Recommended for short NL questions.' },
    },
    required: ['project_name', 'question'],
  },
  handler: withProject(withSnapshotErrorHandling(async (args, { db, hybridSearch }, project) => {
    const question = args.question as string;
    const hyde = args.hyde === true;
    const sections: string[] = [`=== Context for: "${question}"${hyde ? ' (expanded)' : ''} ===`];

    const snaps = await hybridSearch.searchSnapshotsHybrid(project.id, project.name, question, 3);
    if (snaps.length > 0) {
      sections.push('\n[SNAPSHOTS]');
      sections.push(snaps.map(s => `- ${s.title} [${s.category}]: ${s.content.replace(/\s+/g, ' ').slice(0, 200)}`).join('\n'));
    }

    try {
      const fileResults = hyde
        ? await hybridSearch.searchExpanded(project.id, project.name, question, { type: 'files', limit: 5 })
        : await hybridSearch.search(project.id, project.name, question, { mode: 'hybrid', type: 'files', limit: 5 });
      if (fileResults.length > 0) {
        sections.push('\n[TOP FILES]');
        sections.push(fileResults.map(r => {
          const f = r.data as unknown as Record<string, unknown>;
          return `${f.path} | ${f.layer} | ${f.summary || ''}`.slice(0, 200);
        }).join('\n'));

        // ── Graph neighbors: 1-hop dependencies/dependents ──
        const neighborPaths = new Set<string>();
        const topFilePaths = new Set(fileResults.map(r => (r.data as unknown as { path: string }).path));
        for (const r of fileResults.slice(0, 3)) {
          const f = r.data as unknown as { id: number; path: string };
          const deps = db.getDependencies(f.id, project.id);
          const dependents = db.getDependents(project.id, f.id);
          for (const d of [...deps, ...dependents]) {
            const path = 'target_file_path' in d ? d.target_file_path : (d as { source_file_path: string }).source_file_path;
            if (path && !topFilePaths.has(path)) neighborPaths.add(path);
          }
        }
        if (neighborPaths.size > 0) {
          const neighborFiles = [...neighborPaths].slice(0, 5).map(p => {
            const file = db.getFile(project.id, p);
            return file ? `${file.path} | ${file.layer} | ${file.summary || ''}`.slice(0, 200) : p;
          });
          sections.push('\n[RELATED FILES (graph neighbors)]');
          sections.push(neighborFiles.join('\n'));
        }
      }
      const symResults = hyde
        ? await hybridSearch.searchExpanded(project.id, project.name, question, { type: 'symbols', limit: 8 })
        : await hybridSearch.search(project.id, project.name, question, { mode: 'hybrid', type: 'symbols', limit: 8 });
      if (symResults.length > 0) {
        sections.push('\n[TOP SYMBOLS]');
        sections.push(symResults.map(r => {
          const s = r.data as unknown as Record<string, unknown>;
          return `${s.file_path}:${s.line ?? '?'} ${s.kind} ${s.name}${s.comment ? ` — ${String(s.comment).slice(0, 100)}` : ''}`;
        }).join('\n'));
      }
    } catch (e) {
      sections.push(`\n[search error] ${(e as Error).message}`);
    }

    return truncateToTokens(sections.join('\n'), (args.max_tokens as number | undefined) ?? 2000);
  })),
});

// ─── Memory-framed tools (Mem D) ─────────────────────────────────────
// Same snapshot backend, names the agent reaches for intuitively: it treats
// snapshots as "project memory" — search before exploring, save durable facts.

const search_memory = defineTool({
  name: 'search_memory',
  description:
    'Search PROJECT MEMORY (past decisions, conventions, gotchas, how-to recipes, architecture, and auto-indexed facts) by meaning — hybrid FTS+vector. USE before exploring code or figuring out how to run/build/test/deploy; many answers are already remembered. DON\'T use for live file contents (use read_file). Pass format="json" for structured results.',
  inputSchema: {
    type: 'object',
    properties: {
      project_name: { type: 'string' },
      query: { type: 'string' },
      limit: { type: 'number' },
      format: { type: 'string', enum: ['text', 'json'] },
    },
    required: ['project_name', 'query'],
  },
  handler: withProject(withSnapshotErrorHandling(async (args, { db, snapshotService, hybridSearch }, project) => {
    const query = (args.query as string).trim();
    if (!query) return 'search_memory requires a non-empty query.';
    const limit = (args.limit as number) ?? 5;
    const raw = await hybridSearch.searchSnapshotsHybrid(project.id, project.name, query, limit);
    if (raw.length === 0) {
      const total = db.countSnapshots(project.id);
      return total === 0
        ? 'No project memory yet. Use save_memory to record one, or index the project to auto-generate memory.'
        : `No memory matched "${query}" (${total} entries exist). Try broader terms.`;
    }
    const results = snapshotService.annotateStaleMany(project.id, raw);
    if (args.format === 'json') {
      return JSON.stringify({
        query,
        total: results.length,
        results: results.map((s) => ({
          id: s.id, title: s.title, category: s.category, content: s.content,
          source: s.source, importance: s.importance,
        })),
      });
    }
    return results.map((s) => `## ${s.title} [${s.category}]\n${s.content}`).join('\n\n---\n\n');
  })),
});

const save_memory = defineTool({
  name: 'save_memory',
  description:
    'Save a DURABLE fact to PROJECT MEMORY for future sessions — a decision (and why), a convention, a non-obvious gotcha/constraint, a reusable how-to recipe, or an architecture note. USE for things that stay true beyond the current task. DON\'T use for transient task state. Provide a specific title + 1-4 sentence content.',
  inputSchema: {
    type: 'object',
    properties: {
      project_name: { type: 'string' },
      title: { type: 'string' },
      category: { type: 'string', enum: ['architecture', 'decision', 'pattern', 'convention', 'todo', 'note', 'gotcha', 'procedure'] },
      content: { type: 'string' },
      referenced_files: {
        type: 'array', items: { type: 'string' },
        description: 'Project-relative paths this memory depends on (staleness tracking).',
      },
      importance: { type: 'number', description: '0..1 salience — how reusable/durable. Decisions/conventions high.' },
    },
    required: ['project_name', 'title', 'category', 'content'],
  },
  handler: withProject(withSnapshotErrorHandling(async (args, { snapshotService }, project, authCtx) => {
    const result = await snapshotService.create(project.id, {
      title: args.title as string,
      category: args.category as SnapshotCategory,
      content: args.content as string,
      referencedFiles: args.referenced_files as string[] | undefined,
      createdBy: authCtx?.principal ?? 'agent',
      source: 'agent',
      importance: typeof args.importance === 'number' ? args.importance : undefined,
    });
    const embed = summarizeEmbedError(result.embedError);
    const embedNote = embed ? ` (warning: vector index failed — pending backfill: ${embed})` : '';
    return `Memory #${result.snap.id} "${result.snap.title}" saved.${embedNote}`;
  })),
});

export const snapshotTools: McpTool[] = [
  add_snapshot,
  list_snapshots,
  update_snapshot,
  delete_snapshot,
  get_snapshot_history,
  get_project_context,
  query_snapshots,
  get_context_for,
  search_memory,
  save_memory,
];

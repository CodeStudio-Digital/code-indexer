import { defineTool, type McpTool } from '../tool.js';
import { resolveProject, truncateToTokens } from '../utils.js';
import type { SnapshotCategory } from '../../../types.js';

const add_snapshot = defineTool({
  name: 'add_snapshot',
  description: 'Add a context snapshot. Pass referenced_files to track files the snapshot depends on; the snapshot will be marked STALE when those files change.',
  inputSchema: {
    type: 'object',
    properties: {
      project_name: { type: 'string' },
      title: { type: 'string' },
      category: { type: 'string', enum: ['architecture', 'decision', 'pattern', 'convention', 'todo', 'note'] },
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
  handler: (args, { db, snapshotService }) => {
    const project = resolveProject(db, args.project_name as string);
    const snap = snapshotService.create(project.id, {
      title: args.title as string,
      category: args.category as SnapshotCategory,
      content: args.content as string,
      tags: args.tags as string[] | undefined,
      referencedFiles: args.referenced_files as string[] | undefined,
    });
    const refCount = (args.referenced_files as string[] | undefined)?.length ?? 0;
    const refNote = refCount > 0 ? ` (tracking ${refCount} referenced file${refCount === 1 ? '' : 's'} for staleness)` : '';
    return `Snapshot #${snap.id} "${snap.title}" created.${refNote}`;
  },
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
  handler: (args, { db, snapshotService }) => {
    const project = resolveProject(db, args.project_name as string);
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
  },
});

const update_snapshot = defineTool({
  name: 'update_snapshot',
  description: 'Update a snapshot',
  inputSchema: {
    type: 'object',
    properties: {
      snapshot_id: { type: 'number' },
      title: { type: 'string' },
      category: { type: 'string' },
      content: { type: 'string' },
    },
    required: ['snapshot_id'],
  },
  handler: (args, { snapshotService }) => {
    snapshotService.update(args.snapshot_id as number, {
      title: args.title as string | undefined,
      category: args.category as SnapshotCategory | undefined,
      content: args.content as string | undefined,
    });
    return `Snapshot #${args.snapshot_id} updated.`;
  },
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
    snapshotService.delete(args.snapshot_id as number);
    return `Snapshot #${args.snapshot_id} deleted.`;
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
    const history = snapshotService.getHistory(args.snapshot_id as number);
    return history.map(v => [
      `## Version ${v.version} — ${v.updated_at} by ${v.updated_by}`,
      `Title: ${v.title} [${v.category}]`,
      '',
      v.content,
    ].join('\n')).join('\n\n---\n\n') || 'No version history.';
  },
});

const get_project_context = defineTool({
  name: 'get_project_context',
  description: 'Get all context snapshots formatted as markdown',
  inputSchema: {
    type: 'object',
    properties: { project_name: { type: 'string' }, max_tokens: { type: 'number' } },
    required: ['project_name'],
  },
  handler: (args, { db, snapshotService }) => {
    const project = resolveProject(db, args.project_name as string);
    const ctx = snapshotService.getForContext(project.id) || 'No context snapshots available.';
    return truncateToTokens(ctx, args.max_tokens as number | undefined);
  },
});

const query_snapshots = defineTool({
  name: 'query_snapshots',
  description: 'FTS search over project snapshots. Try this BEFORE exploring code — many questions are already answered in auto-snapshots. Results include a stale flag when referenced files have changed since the snapshot was created. Pass format="json" for a structured response.',
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
  handler: async (args, { db, snapshotService, hybridSearch }) => {
    const project = resolveProject(db, args.project_name as string);
    const query = args.query as string;
    const limit = (args.limit as number) ?? 5;
    const compact = args.compact !== false;
    const asJson = args.format === 'json';
    // Hybrid (FTS + vector RRF) so semantic matches surface even when the
    // user's phrasing doesn't contain the snapshot's keywords.
    const raw = await hybridSearch.searchSnapshotsHybrid(project.id, project.name, query, limit);
    if (raw.length === 0) {
      // Distinguish "project has no snapshots" from "query didn't match any".
      const countFn = (db as unknown as Record<string, unknown>).countSnapshots as ((id: number) => number) | undefined;
      const total = countFn?.(project.id) ?? -1;
      const detail = total === 0
        ? 'This project has no snapshots yet. Use add_snapshot to create one, or index the project first.'
        : total > 0
          ? `No snapshots matched "${query}" (${total} snapshots exist). Try broader terms.`
          : 'No matching snapshots.';
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
  },
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
  handler: async (args, { db, hybridSearch }) => {
    const project = resolveProject(db, args.project_name as string);
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
          const deps = db.getDependencies(f.id);
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
  },
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
];

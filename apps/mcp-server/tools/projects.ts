import {
  defineTool,
  mcpAccess,
  type McpSourceTruncation,
  type McpTool,
  type McpToolResult,
} from '../tool.js';
import { truncateToTokensDetailed } from '../utils.js';
import { getRepoMap } from './repo-map.js';
import { withProject } from './_helpers.js';
import { basename, resolve } from 'node:path';
import { requestMcpLocalServer } from '../server-control.js';
import { buildProjectSummary } from '../project-summary.js';
import { indexPageArgs } from './index-navigation.js';



function positiveBudget(value: unknown): number | undefined {
  const budget = Number(value);
  return Number.isFinite(budget) && budget > 0 ? budget : undefined;
}

function outputWithBudget(
  text: string,
  maxTokens: number | undefined,
  technique: string,
  sourceTruncations: McpSourceTruncation[] = [],
): McpToolResult {
  const limited = truncateToTokensDetailed(text, maxTokens);
  if (limited.truncated) {
    sourceTruncations.push({
      technique,
      inputSize: limited.inputChars,
      outputSize: limited.retainedChars,
      unit: 'chars',
      recoverable: true,
    });
  }
  return sourceTruncations.length > 0
    ? { text: limited.text, sourceTruncations }
    : limited.text;
}

const index_project = defineTool({
  name: 'index_project',
  tier: 'admin',
  ...mcpAccess('admin'),
  description:
    'Reconcile the structural index for one project, then start its configured semantic generation. ' +
    'Structural indexing extracts files, symbols, references and dependencies; semantic work runs in the server-owned worker. ' +
    'Use rebuild_semantic only when you intentionally want to replace the active vector generation.',
  inputSchema: {
    type: 'object',
    properties: {
      project_path: { type: 'string', description: 'Path to project root' },
      rebuild_semantic: {
        type: 'boolean',
        description: 'Build a replacement semantic generation instead of starting/catching up the current one.',
      },
    },
    required: ['project_path'],
  },
  handler: async (args, ctx) => {
    ctx.signal?.throwIfAborted();
    if (typeof args.project_path !== 'string' || !args.project_path.trim() || args.project_path.length > 32768
      || args.project_path.includes('\0') || (args.rebuild_semantic != null && typeof args.rebuild_semantic !== 'boolean')) throw new Error('Invalid project indexing arguments');
    const projectPath = resolve(args.project_path as string);
    const uncertain = (stage: string): McpToolResult => ({ effectOutcome: 'unknown',
      text: `Indexing lost confirmation during ${stage}. Inspect the project index and its jobs before authorizing another mutation.` });
    let project = ctx.db.getProjectByPath(projectPath);
    if (!project) {
      const created = await requestMcpLocalServer('/api/projects', {
        method: 'POST',
        signal: ctx.signal,
        body: JSON.stringify({ name: basename(projectPath), root_path: projectPath }),
      }, { config: ctx.config });
      if (!created.ok) {
        if (!created.reached || (created.status ?? 500) >= 500) return uncertain('project registration');
        throw new Error(
          `Index writes require the local owner server; project registration failed: ${created.error ?? 'unavailable'}`,
        );
      }
      project = created.body as typeof project;
    }
    if (!project?.id) throw new Error(`Unable to resolve project for ${projectPath}`);
    const structuralResponse = await requestMcpLocalServer(
      `/api/projects/${project.id}/index/structural/reconcile`,
      { method: 'POST', signal: ctx.signal },
      { config: ctx.config, timeoutMs: 190_000 },
    );
    if (!structuralResponse.ok) {
      if (!structuralResponse.reached || (structuralResponse.status ?? 500) >= 500) return uncertain('structural reconciliation');
      throw new Error(
        `Structural indexing requires the local owner server: ${structuralResponse.error ?? 'unavailable'}`,
      );
    }
    const structural = structuralResponse.body as {
      ok?: boolean;
      readiness?: { status?: string; phase?: string };
      status?: { phase?: string; indexedFiles?: number; symbolCount?: number };
    } | null;
    if (structural?.ok === false) {
      const state = structural.readiness?.status ?? structural.status?.phase ?? 'not_ready';
      return `Structural reconciliation is still ${state}; semantic indexing was not started. Retry after the structural index becomes ready.`;
    }

    const semanticAction = args.rebuild_semantic === true ? 'rebuild' : 'start';
    ctx.signal?.throwIfAborted();
    const semanticResponse = await requestMcpLocalServer(`/api/projects/${project.id}/semantic/reindex`, {
      method: 'POST',
      signal: ctx.signal,
      body: JSON.stringify({ action: semanticAction }),
    }, { config: ctx.config, timeoutMs: 10_000 });
    const structuralState = structural?.status?.phase ?? structural?.readiness?.phase ?? 'ready';
    if (!semanticResponse.ok) {
      if (!semanticResponse.reached || (semanticResponse.status ?? 500) >= 500) return uncertain('semantic scheduling');
      return `Structural index is ${structuralState}. Semantic indexing was not started (${semanticResponse.error ?? 'profile disabled or worker unavailable'}); FTS and structural tools remain available.`;
    }
    const semantic = semanticResponse.body as { job?: { id?: number; status?: string }; scheduled?: boolean } | null;
    const job = semantic?.job?.id ? ` job #${semantic.job.id}` : '';
    return `Structural index is ${structuralState}. Semantic ${semanticAction}${job} was accepted by the server-owned worker.`;
  },
});

const get_project_overview = defineTool({
  name: 'get_project_overview',
  tier: 'navigate',
  ...mcpAccess('read'),
  description: 'Get a structural project overview with files, symbols, languages and semantic-generation status. File pages default to 500 entries (compact: 50). Use offset to continue; max_files is capped at 500.',
  inputSchema: {
    type: 'object',
    properties: {
      project_name: { type: 'string' },
      compact: { type: 'boolean' },
      max_tokens: { type: 'number' },
      max_files: { type: 'number', description: 'Files per page (compact default 50, otherwise 500; max 500). Zero omits file listing.' },
      offset: { type: 'number', description: 'File offset; restart at 0 after index changes.' },
    },
    required: ['project_name'],
  },
  handler: withProject((args, ctx, project) => {
    const { db } = ctx;
    ctx.signal?.throwIfAborted();
    const summary = buildProjectSummary(ctx, project);
    const compact = args.compact === true;
    const requested = args.max_files == null ? (compact ? 50 : 500) : Number(args.max_files);
    if (!Number.isSafeInteger(requested) || requested < 0) throw new Error('max_files must be a non-negative integer');
    const page = db.listAgentIndexFiles(project.id, indexPageArgs({ offset: args.offset, limit: Math.max(1, requested) }));
    if (page.offset > page.total) throw new Error('Offset exceeds current files; restart from offset 0');
    const files = requested === 0 ? [] : page.items;
    const omitted = page.offset > 0 || files.length < page.total;
    const next = requested === 0 ? page.offset : page.nextOffset;
    const fileTrunc = omitted ? `\n  ... [${page.total - files.length} more files omitted — ${next != null ? 'Continue' : 'Earlier pages'}: mcp__get_project_overview(${JSON.stringify({ ...args, offset: next ?? 0, max_files: requested || 50 })}). Restart at offset 0 after index changes.]` : '';
    const sourceTruncations: McpSourceTruncation[] = omitted ? [{ technique: 'mcp-project-overview-file-limit', inputSize: page.total, outputSize: files.length, unit: 'items', recoverable: true }] : [];
    ctx.signal?.throwIfAborted();

    if (compact) {
      const langs = Object.entries(summary.languages).sort((a, b) => b[1] - a[1]).map(([l, c]) => `${l}(${c})`).join(' ');
      const directories = summary.top_directories.map((row) => `${row.path}(${row.files})`).join(' ');
      const shownFiles = files;
      const semantic = `${summary.semantic.state} ${summary.semantic.indexed_items}/${summary.semantic.expected_items} (${summary.semantic.coverage_pct}%)`;
      const out = `${project.name} | ${summary.file_count}f ${summary.symbol_count}s ${summary.total_lines}L\nlangs: ${langs}\ndirectories: ${directories}\nstructural: ${summary.structural.state}\nsemantic: ${semantic}\nfiles:\n${shownFiles.map(f => `  ${f.path} (${f.language},${f.line_count}L)`).join('\n')}${fileTrunc}`;
      return outputWithBudget(
        out,
        positiveBudget(args.max_tokens),
        'mcp-project-overview-token-budget',
        sourceTruncations,
      );
    }

    const sections = [
      `# ${project.name}`,
      `Path: ${project.root_path}`,
      `Files: ${summary.file_count} | Symbols: ${summary.symbol_count} | Lines: ${summary.total_lines.toLocaleString()}`,
      `Structural: ${summary.structural.state} | Indexed: ${summary.structural.indexed_at ?? 'Never'} | Checked: ${summary.structural.last_checked_at ?? 'Never'}`,
      `Semantic: ${summary.semantic.state} | Generation: ${summary.semantic.active_generation_id ?? summary.semantic.building_generation_id ?? 'none'} | Coverage: ${summary.semantic.indexed_items}/${summary.semantic.expected_items} (${summary.semantic.coverage_pct}%)`,
      '',
      '## Languages',
      Object.entries(summary.languages).sort((a, b) => b[1] - a[1]).map(([l, c]) => `- ${l}: ${c} files`).join('\n'),
    ];

    if (summary.top_directories.length > 0) {
      sections.push('', '## Top-level directories', summary.top_directories.map(row => `- ${row.path}: ${row.files} files`).join('\n'));
    }
    sections.push('', '## Files', files.map(f => `- ${f.path} (${f.language}, ${f.line_count} lines)`).join('\n'), fileTrunc);
    return outputWithBudget(
      sections.join('\n'),
      positiveBudget(args.max_tokens),
      'mcp-project-overview-token-budget',
      sourceTruncations,
    );
  }),
});

const get_project_pulse = defineTool({
  name: 'get_project_pulse',
  tier: 'bootstrap',
  ...mcpAccess('read'),
  description: 'Ultra-compact index-health and project-shape overview (~250 tokens). For code questions, start with mcp__search; use this only when index readiness or the broad project shape is unknown. Pass format="json" for a structured response.',
  inputSchema: {
    type: 'object',
    properties: {
      project_name: { type: 'string' },
      format: { type: 'string', enum: ['text', 'json'], description: 'Response format (default text)' },
    },
    required: ['project_name'],
  },
  handler: withProject((args, ctx, project) => {
    const summary = buildProjectSummary(ctx, project);
    const langs = Object.entries(summary.languages).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([l, n]) => `${l}(${n})`).join(' ');

    if (args.format === 'json') {
      return JSON.stringify(summary);
    }

    const lines = [
      `${project.name} | ${summary.file_count} files, ${summary.symbol_count} symbols, ${summary.total_lines}L`,
      `langs: ${langs}`,
      `directories: ${summary.top_directories.map((row) => `${row.path}(${row.files})`).join(' ')}`,
      summary.key_files.length ? `key files: ${summary.key_files.join(', ')}` : '',
      `structural: ${summary.structural.state} | indexed ${summary.structural.indexed_at ?? 'never'} | checked ${summary.structural.last_checked_at ?? 'never'}`,
      `semantic: ${summary.semantic.state} | generation ${summary.semantic.active_generation_id ?? summary.semantic.building_generation_id ?? 'none'} | coverage ${summary.semantic.indexed_items}/${summary.semantic.expected_items} (${summary.semantic.coverage_pct}%) | deltas ${summary.semantic.pending_delta_items}`,
      summary.semantic.error ? `semantic error: ${summary.semantic.error}` : '',
      `snapshots: ${summary.snapshots_count}`,
    ].filter(Boolean);
    return lines.join('\n');
  }),
});

// `get_architecture` was retired from the MCP surface. Structural directory,
// dependency and symbol context is available through overview + repo map.
export const projectTools: McpTool[] = [
  index_project,
  get_project_overview,
  get_project_pulse,
  getRepoMap,
];

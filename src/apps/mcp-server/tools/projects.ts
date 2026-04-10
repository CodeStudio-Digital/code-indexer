import { defineTool, type McpTool } from '../tool.js';
import { resolveProject, truncateToTokens } from '../utils.js';
import { createProviderAsync } from '../../../core/providers/factory.js';
import { IndexAgent } from '../../../core/indexer/indexer.js';
import type { ProviderName } from '../../../types.js';

const list_projects = defineTool({
  name: 'list_projects',
  description: 'List all indexed projects',
  inputSchema: { type: 'object', properties: {} },
  handler: (_args, { db }) => {
    const projects = db.listProjects();
    return projects
      .map(p => `${p.name} (${p.root_path}) — ${p.file_count} files, last indexed: ${p.last_indexed ?? 'never'}`)
      .join('\n') || 'No projects registered.';
  },
});

const delete_project = defineTool({
  name: 'delete_project',
  description: 'Delete an indexed project',
  inputSchema: {
    type: 'object',
    properties: { project_name: { type: 'string' } },
    required: ['project_name'],
  },
  handler: (args, { db }) => {
    const project = resolveProject(db, args.project_name as string);
    db.deleteProject(project.id);
    return `Project "${project.name}" deleted.`;
  },
});

const index_project = defineTool({
  name: 'index_project',
  description: 'Index or re-index a project',
  inputSchema: {
    type: 'object',
    properties: {
      project_path: { type: 'string', description: 'Path to project root' },
      provider: { type: 'string' },
      model: { type: 'string' },
      force: { type: 'boolean' },
    },
    required: ['project_path'],
  },
  handler: async (args, ctx) => {
    const { db, config, embeddingService, vectorStore, costTracker, webhookDispatcher } = ctx;
    const provider = await createProviderAsync(
      ((args.provider as string) ?? config.provider) as ProviderName,
      (args.model as string) ?? config.model,
    );
    const agent = new IndexAgent(db, provider, embeddingService, vectorStore, costTracker, webhookDispatcher, config);
    const result = await agent.indexProject(args.project_path as string, { force: args.force as boolean });
    return `Indexed ${result.indexedFiles} files (${result.skippedFiles} skipped, ${result.errorCount} errors) in ${(result.durationMs / 1000).toFixed(1)}s. Cost: $${result.costUsd.toFixed(4)}`;
  },
});

const get_project_stats = defineTool({
  name: 'get_project_stats',
  description: 'Get project statistics',
  inputSchema: {
    type: 'object',
    properties: { project_name: { type: 'string' } },
    required: ['project_name'],
  },
  handler: (args, { db }) => {
    const project = resolveProject(db, args.project_name as string);
    return JSON.stringify(db.getStats(project.id), null, 2);
  },
});

const get_project_overview = defineTool({
  name: 'get_project_overview',
  description: 'Get project overview with file list and concepts. Use compact=true for dense output. In compact mode, file list is capped by max_files (default 50).',
  inputSchema: {
    type: 'object',
    properties: {
      project_name: { type: 'string' },
      compact: { type: 'boolean' },
      max_tokens: { type: 'number' },
      max_files: { type: 'number', description: 'Max files listed in compact mode (default 50)' },
    },
    required: ['project_name'],
  },
  handler: (args, { db }) => {
    const project = resolveProject(db, args.project_name as string);
    const stats = db.getStats(project.id);
    const concepts = db.listConcepts(project.id);
    const files = db.listFiles(project.id);
    const archOverview = db.getArchitectureOverview(project.id);
    const compact = args.compact === true;

    if (compact) {
      const maxFiles = (args.max_files as number) ?? 50;
      const langs = Object.entries(stats.languages).sort((a, b) => b[1] - a[1]).map(([l, c]) => `${l}(${c})`).join(' ');
      const layers = archOverview.map(l => `${l.layer}(${l.count})`).join(' ');
      const conc = concepts.slice(0, 8).map(c => c.concept).join(', ');
      const shownFiles = files.slice(0, maxFiles);
      const fileTrunc = files.length > maxFiles
        ? `\n  ... [${files.length - maxFiles} more files omitted — use max_files to expand]`
        : '';
      const out = `${project.name} | ${stats.file_count}f ${stats.symbol_count}s ${stats.total_lines}L\nlangs: ${langs}\nlayers: ${layers}\nconcepts: ${conc}\nfiles:\n${shownFiles.map(f => `  ${f.path} (${f.language},${f.line_count}L)`).join('\n')}${fileTrunc}`;
      return truncateToTokens(out, args.max_tokens as number | undefined);
    }

    const sections = [
      `# ${project.name}`,
      `Path: ${project.root_path}`,
      `Files: ${stats.file_count} | Symbols: ${stats.symbol_count} | Lines: ${stats.total_lines.toLocaleString()} | Runs: ${stats.run_count}`,
      `Last Indexed: ${stats.last_indexed ?? 'Never'}`,
      '',
      '## Languages',
      Object.entries(stats.languages).sort((a, b) => b[1] - a[1]).map(([l, c]) => `- ${l}: ${c} files`).join('\n'),
    ];

    if (archOverview.length > 0) {
      sections.push('', '## Architecture Layers', archOverview.map(l => `- ${l.layer}: ${l.count} files`).join('\n'));
    }
    if (concepts.length > 0) {
      sections.push('', '## Key Concepts', concepts.map(c => `- ${c.concept} (${c.count} files)`).join('\n'));
    }
    sections.push('', '## Files', files.map(f => `- ${f.path} (${f.language}, ${f.line_count} lines, ${f.complexity})`).join('\n'));
    return truncateToTokens(sections.join('\n'), args.max_tokens as number | undefined);
  },
});

const get_project_pulse = defineTool({
  name: 'get_project_pulse',
  description: 'Ultra-compact project overview (~250 tokens). Use this as the FIRST contextualization tool. Pass format="json" for a structured response.',
  inputSchema: {
    type: 'object',
    properties: {
      project_name: { type: 'string' },
      format: { type: 'string', enum: ['text', 'json'], description: 'Response format (default text)' },
    },
    required: ['project_name'],
  },
  handler: (args, { db }) => {
    const project = resolveProject(db, args.project_name as string);
    const stats = db.getStats(project.id);
    const arch = db.getArchitectureOverview(project.id);
    const files = db.listFiles(project.id);
    const conceptCount = new Map<string, number>();
    const entryPoints: string[] = [];
    for (const f of files) {
      if (f.is_entry_point) entryPoints.push(f.path);
      try {
        const cs = JSON.parse(f.concepts || '[]') as string[];
        for (const c of cs) conceptCount.set(c, (conceptCount.get(c) ?? 0) + 1);
      } catch { /* ignore */ }
    }
    const topConcepts = [...conceptCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([c]) => c);
    const langs = Object.entries(stats.languages).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([l, n]) => `${l}(${n})`).join(' ');
    const layers = arch.map(a => `${a.layer}(${a.count})`).join(' ');
    const snaps = db.listSnapshots(project.id);
    const costs = db.getCostSummary(project.id);
    const avgCost = stats.file_count > 0 ? costs.total_cost_usd / stats.file_count : 0;
    const cov = db.getEmbeddingCoverage(project.id);
    const filePct = cov.files_total > 0 ? Math.round((cov.files_embedded / cov.files_total) * 100) : 0;
    const symPct = cov.symbols_total > 0 ? Math.round((cov.symbols_embedded / cov.symbols_total) * 100) : 0;
    const bodyPct = cov.symbol_bodies_total > 0 ? Math.round((cov.symbol_bodies_embedded / cov.symbol_bodies_total) * 100) : 0;

    if (args.format === 'json') {
      return JSON.stringify({
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
          per_file_avg_usd: avgCost,
        },
      });
    }

    const costLine = costs.total_cost_usd > 0
      ? `cost: $${costs.total_cost_usd.toFixed(4)} (llm $${costs.llm_analysis_cost_usd.toFixed(4)} + emb $${costs.embedding_cost_usd.toFixed(4)}) | avg/file: $${avgCost.toFixed(5)}`
      : '';
    const covLine = cov.files_total > 0
      ? `vector coverage: files ${filePct}% | symbols ${symPct}% | bodies ${bodyPct}%`
      : 'vector coverage: none (search will use FTS only)';
    const lines = [
      `${project.name} | ${stats.file_count} files, ${stats.symbol_count} symbols, ${stats.total_lines}L | indexed: ${stats.last_indexed ?? 'never'}`,
      `langs: ${langs}`,
      `layers: ${layers}`,
      `top concepts: ${topConcepts.join(', ')}`,
      entryPoints.length ? `entry points: ${entryPoints.slice(0, 5).join(', ')}` : '',
      `snapshots: ${snaps.length}`,
      covLine,
      costLine,
    ].filter(Boolean);
    return lines.join('\n');
  },
});

const get_architecture = defineTool({
  name: 'get_architecture',
  description: 'Get project architecture overview (files grouped by layer)',
  inputSchema: {
    type: 'object',
    properties: { project_name: { type: 'string' } },
    required: ['project_name'],
  },
  handler: (args, { db }) => {
    const project = resolveProject(db, args.project_name as string);
    const overview = db.getArchitectureOverview(project.id);
    return overview.map(l => `${l.layer}: ${l.count} files`).join('\n') || 'No architecture data.';
  },
});

export const projectTools: McpTool[] = [
  list_projects,
  delete_project,
  index_project,
  get_project_stats,
  get_project_overview,
  get_project_pulse,
  get_architecture,
];

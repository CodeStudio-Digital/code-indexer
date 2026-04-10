import { minimatch } from 'minimatch';
import { defineTool, type McpTool } from '../tool.js';
import { resolveProject } from '../utils.js';
import { grepInFiles } from '../../../core/services/code-reader.js';
import type { SearchMode, SearchType } from '../../../types.js';

const search = defineTool({
  name: 'search',
  description: 'Search files and symbols in a project',
  inputSchema: {
    type: 'object',
    properties: {
      project_name: { type: 'string' },
      query: { type: 'string' },
      mode: { type: 'string', enum: ['fts', 'vector', 'hybrid'] },
      type: { type: 'string', enum: ['files', 'symbols', 'all'] },
      limit: { type: 'number' },
    },
    required: ['project_name', 'query'],
  },
  handler: async (args, { db, hybridSearch }) => {
    const project = resolveProject(db, args.project_name as string);
    const results = await hybridSearch.search(project.id, project.name, args.query as string, {
      mode: (args.mode as SearchMode) ?? 'hybrid',
      type: (args.type as SearchType) ?? 'all',
      limit: (args.limit as number) ?? 20,
    });
    return results.map(r => {
      const d = r.data as unknown as Record<string, unknown>;
      if (r.type === 'file') {
        const concepts = (() => { try { return JSON.parse(d.concepts as string ?? '[]').join(', '); } catch { return ''; } })();
        return [
          `## [file] ${d.path} (score: ${r.score.toFixed(3)})`,
          `Language: ${d.language} | Lines: ${d.line_count} | Complexity: ${d.complexity}${d.layer && d.layer !== 'unknown' ? ` | Layer: ${d.layer}` : ''}`,
          `Summary: ${d.summary ?? ''}`,
          concepts ? `Concepts: ${concepts}` : '',
        ].filter(Boolean).join('\n');
      }
      return [
        `## [symbol] ${d.name} (${d.kind}) — score: ${r.score.toFixed(3)}`,
        `File: ${d.file_path}:${d.line ?? '?'}`,
        `Signature: ${d.signature ?? ''}`,
        d.comment ? `Description: ${d.comment}` : '',
        d.parent ? `Parent: ${d.parent}` : '',
      ].filter(Boolean).join('\n');
    }).join('\n\n') || 'No results found.';
  },
});

const search_global = defineTool({
  name: 'search_global',
  description: 'Search across all projects',
  inputSchema: {
    type: 'object',
    properties: { query: { type: 'string' }, limit: { type: 'number' } },
    required: ['query'],
  },
  handler: async (args, { db, hybridSearch }) => {
    const projects = db.listProjects();
    const allResults = [];
    for (const p of projects) {
      const results = await hybridSearch.search(p.id, p.name, args.query as string, { limit: (args.limit as number) ?? 10 });
      allResults.push(...results.map(r => ({ ...r, projectName: p.name })));
    }
    allResults.sort((a, b) => b.score - a.score);
    return allResults.slice(0, (args.limit as number) ?? 20).map(r => {
      const d = r.data as unknown as Record<string, unknown>;
      const pName = (r as unknown as { projectName: string }).projectName;
      if (r.type === 'file') {
        return [
          `## [${pName}] [file] ${d.path} (score: ${r.score.toFixed(3)})`,
          `Language: ${d.language} | Lines: ${d.line_count} | Complexity: ${d.complexity}`,
          `Summary: ${d.summary ?? ''}`,
        ].join('\n');
      }
      return [
        `## [${pName}] [symbol] ${d.name} (${d.kind}) — score: ${r.score.toFixed(3)}`,
        `File: ${d.file_path}:${d.line ?? '?'}`,
        `Signature: ${d.signature ?? ''}`,
        d.comment ? `Description: ${d.comment}` : '',
      ].filter(Boolean).join('\n');
    }).join('\n\n') || 'No results found.';
  },
});

const search_concepts = defineTool({
  name: 'search_concepts',
  description: 'Find files by concept',
  inputSchema: {
    type: 'object',
    properties: { project_name: { type: 'string' }, concept: { type: 'string' } },
    required: ['project_name', 'concept'],
  },
  handler: (args, { db }) => {
    const project = resolveProject(db, args.project_name as string);
    const files = db.getFilesByConcept(project.id, args.concept as string);
    return files.map(f => `- **${f.path}** (${f.language}, ${f.line_count} lines) — ${f.summary}`).join('\n') || 'No files found.';
  },
});

const search_by_kind = defineTool({
  name: 'search_by_kind',
  description: 'Search symbols by kind. Common kinds: function, class, interface, type, enum, method, property, variable, constant.',
  inputSchema: {
    type: 'object',
    properties: { project_name: { type: 'string' }, kind: { type: 'string' }, limit: { type: 'number' } },
    required: ['project_name', 'kind'],
  },
  handler: (args, { db }) => {
    const project = resolveProject(db, args.project_name as string);
    const kind = args.kind as string;
    const symbols = db.listSymbolsByKind(project.id, kind, (args.limit as number) ?? 50);
    if (symbols.length === 0) {
      return `No symbols found with kind "${kind}". Common kinds: function, class, interface, type, enum, method, property, variable, constant.`;
    }
    return symbols.map(s => `${s.kind} ${s.name} — ${s.file_path}:${s.line ?? '?'} | ${s.signature}`).join('\n');
  },
});

const grep_code = defineTool({
  name: 'grep_code',
  description: 'Textual search across project files with filters (language/layer/glob). Results capped at max_results (default 50). Use literal=true for exact string matching.',
  inputSchema: {
    type: 'object',
    properties: {
      project_name: { type: 'string' },
      pattern: { type: 'string' },
      literal: { type: 'boolean' },
      case_sensitive: { type: 'boolean' },
      language: { type: 'string' },
      layer: { type: 'string' },
      glob: { type: 'string' },
      max_results: { type: 'number' },
    },
    required: ['project_name', 'pattern'],
  },
  handler: (args, { db }) => {
    const project = resolveProject(db, args.project_name as string);
    const pattern = args.pattern as string;
    let literal = args.literal === true;
    const ci = !args.case_sensitive;
    const lang = args.language as string | undefined;
    const layer = args.layer as string | undefined;
    const glob = args.glob as string | undefined;
    const maxResults = (args.max_results as number) ?? 50;
    let files = db.listFiles(project.id, lang);
    if (layer) files = files.filter(f => f.layer === layer);
    if (glob) files = files.filter(f => minimatch(f.path, glob));
    const escaped = literal ? pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') : pattern;
    let re: RegExp;
    let fallbackNote = '';
    try {
      re = new RegExp(escaped, ci ? 'i' : '');
    } catch {
      // Invalid regex — fall back to literal match instead of blocking the agent.
      re = new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), ci ? 'i' : '');
      literal = true;
      fallbackNote = `[note: pattern was not valid regex, searched as literal string]\n`;
    }
    const hits = grepInFiles(project.root_path, files.map(f => f.path), re, maxResults);
    if (hits.length === 0) return fallbackNote + 'No matches.';
    const results = hits.map(h => `${h.file}:${h.line}: ${h.text}`).join('\n');
    const capNote = hits.length >= maxResults ? `\n... [capped at ${maxResults} results]` : '';
    return fallbackNote + results + capNote;
  },
});

export const searchTools: McpTool[] = [search, search_global, search_concepts, search_by_kind, grep_code];

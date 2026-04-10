import { join } from 'node:path';
import { defineTool, type McpTool } from '../tool.js';
import { resolveProject } from '../utils.js';
import { readFileSlice, extractSkeletonFromFile } from '../../../core/services/code-reader.js';

const get_file_structure = defineTool({
  name: 'get_file_structure',
  description: 'Get file details and symbols',
  inputSchema: {
    type: 'object',
    properties: { project_name: { type: 'string' }, file_path: { type: 'string' } },
    required: ['project_name', 'file_path'],
  },
  handler: (args, { db }) => {
    const project = resolveProject(db, args.project_name as string);
    const file = db.getFile(project.id, args.file_path as string);
    if (!file) throw new Error(`File "${args.file_path}" not found in index. Use list_directory or search to find the correct path. Do not retry with the same file_path.`);
    const symbols = db.getSymbolsByFile(project.id, args.file_path as string);
    const concepts = JSON.parse(file.concepts) as string[];
    const deps = db.getDependencies(file.id);
    const dependents = db.getDependents(project.id, file.id);

    const sections = [
      `# ${file.path}`,
      `Language: ${file.language} | Lines: ${file.line_count} | Complexity: ${file.complexity} | Layer: ${file.layer}`,
      file.is_entry_point ? 'Entry Point: yes' : '',
      file.is_test ? 'Test File: yes' : '',
      '',
      `## Summary`,
      file.summary,
      '',
      `## Concepts`,
      concepts.join(', '),
    ].filter(Boolean);

    if (deps.length > 0) {
      sections.push('', '## Dependencies (imports)', deps.map(d => `- [${d.dep_type}] ${d.import_path}${d.target_file_path ? ` → ${d.target_file_path}` : ''}`).join('\n'));
    }
    if (dependents.length > 0) {
      sections.push('', '## Dependents (imported by)', dependents.map(d => `- ${d.source_file_path} (via ${d.import_path})`).join('\n'));
    }
    if (symbols.length > 0) {
      sections.push('', `## Symbols (${symbols.length})`);
      for (const s of symbols) {
        const parts = [`### ${s.kind} \`${s.name}\``];
        if (s.signature) parts.push(`Signature: \`${s.signature}\``);
        if (s.comment) parts.push(s.comment);
        if (s.parent) parts.push(`Parent: ${s.parent}`);
        if (s.line) parts.push(`Line: ${s.line}`);
        const tags = JSON.parse(s.tags) as string[];
        if (tags.length > 0) parts.push(`Tags: ${tags.join(', ')}`);
        sections.push(parts.join('\n'));
      }
    }
    return sections.join('\n');
  },
});

const get_file_skeleton = defineTool({
  name: 'get_file_skeleton',
  description: 'Compact outline of a file: header + symbol list (line, kind, name, signature). Token-cheap alternative to get_file_structure. Symbol count is capped by max_symbols (default 100). Pass format="json" for a structured response.',
  inputSchema: {
    type: 'object',
    properties: {
      project_name: { type: 'string' },
      file_path: { type: 'string' },
      kind: { type: 'string', description: 'Filter by symbol kind' },
      filter: { type: 'string', description: 'Regex on symbol name' },
      max_symbols: { type: 'number', description: 'Max symbols listed (default 100)' },
      format: { type: 'string', enum: ['text', 'json'] },
    },
    required: ['project_name', 'file_path'],
  },
  handler: (args, { db }) => {
    const project = resolveProject(db, args.project_name as string);
    const filePath = args.file_path as string;
    const file = db.getFile(project.id, filePath);
    if (!file) {
      throw new Error(`File "${filePath}" not found in index. Use list_directory or search to find the correct path. Do not retry with the same file_path.`);
    }
    let symbols = db.getSymbolsByFile(project.id, filePath);
    const kindFilter = args.kind as string | undefined;
    const nameFilter = args.filter as string | undefined;
    const maxSymbols = (args.max_symbols as number) ?? 100;
    const asJson = args.format === 'json';
    if (kindFilter) symbols = symbols.filter(s => s.kind === kindFilter);
    if (nameFilter) {
      try { const re = new RegExp(nameFilter); symbols = symbols.filter(s => re.test(s.name)); } catch { /* ignore */ }
    }
    const ext = filePath.split('.').pop() ?? '';
    const concepts = JSON.parse(file.concepts || '[]') as string[];

    const totalSymbols = symbols.length;
    const truncated = totalSymbols > maxSymbols;
    const shownSymbols = truncated ? symbols.slice(0, maxSymbols) : symbols;

    interface ExtraEntry { line: number | null; kind: string; name: string; signature: string; from_fallback: true }
    const extras: ExtraEntry[] = [];
    if (symbols.length < 3 && file.line_count > 80 && !kindFilter && !nameFilter) {
      try {
        const extracted = extractSkeletonFromFile(join(project.root_path, filePath));
        const known = new Set(symbols.map(s => `${s.line}:${s.name}`));
        for (const e of extracted) {
          if (known.has(`${e.line}:${e.name}`)) continue;
          if (extras.length + shownSymbols.length >= maxSymbols) break;
          extras.push({ line: e.line, kind: e.kind, name: e.name, signature: e.signature.slice(0, 100), from_fallback: true });
        }
      } catch { /* ignore */ }
    }

    if (asJson) {
      return JSON.stringify({
        file: {
          path: filePath,
          ext,
          layer: file.layer,
          line_count: file.line_count,
          complexity: file.complexity,
          summary: file.summary || null,
          concepts: concepts.slice(0, 8),
        },
        total_symbols: totalSymbols,
        shown_symbols: shownSymbols.length + extras.length,
        truncated,
        symbols: [
          ...shownSymbols.map(s => ({
            line: s.line,
            kind: s.kind,
            parent: s.parent,
            name: s.name,
            signature: s.signature,
            stable_id: s.stable_id,
          })),
          ...extras,
        ],
      });
    }

    const header = `${filePath} | ${ext} | ${file.layer} | ${file.line_count}L | ${file.complexity}`;
    const summary = file.summary ? `summary: ${file.summary}` : '';
    const cline = concepts.length ? `concepts: ${concepts.slice(0, 8).join(', ')}` : '';
    const truncateNote = truncated
      ? `[truncated: showing ${shownSymbols.length}/${totalSymbols} symbols — use max_symbols or kind/filter to refine]`
      : '';
    const symLines = shownSymbols.map(s => {
      const parent = s.parent ? `${s.parent}.` : '';
      const sig = s.signature || (s.parameters ? `(${s.parameters})` : '');
      return `${String(s.line ?? '?').padStart(5)} ${s.kind} ${parent}${s.name}${sig && sig !== s.name ? ` ${sig}` : ''}`;
    });
    let fallbackNote = '';
    if (extras.length > 0) {
      fallbackNote = `\n[regex fallback -- DB had ${symbols.length} symbols]`;
      for (const e of extras) {
        symLines.push(`${String(e.line ?? '?').padStart(5)} ${e.kind} ${e.name} ${e.signature}`);
      }
    }
    return [header, summary, cline, truncateNote, fallbackNote, '', ...symLines].filter(Boolean).join('\n');
  },
});

const read_file = defineTool({
  name: 'read_file',
  description: 'Read a file slice. Default 100 lines; use start_line/end_line for ranges, max_lines to adjust window, or force=true for the whole file.',
  inputSchema: {
    type: 'object',
    properties: {
      project_name: { type: 'string' },
      file_path: { type: 'string' },
      start_line: { type: 'number' },
      end_line: { type: 'number' },
      max_lines: { type: 'number' },
      force: { type: 'boolean' },
    },
    required: ['project_name', 'file_path'],
  },
  handler: (args, { db }) => {
    const project = resolveProject(db, args.project_name as string);
    const filePath = args.file_path as string;
    const file = db.getFile(project.id, filePath);
    if (!file) throw new Error(`File "${filePath}" not found in index. Use list_directory or search to find the correct path. Do not retry with the same file_path.`);
    const startLine = args.start_line as number | undefined;
    const endLine = args.end_line as number | undefined;
    const maxLines = (args.max_lines as number) ?? 100;
    const force = args.force === true;
    const start = startLine ?? 1;
    const defaultEnd = force ? file.line_count : Math.min(file.line_count, start + maxLines - 1);
    const end = endLine ?? defaultEnd;
    try {
      const slice = readFileSlice(join(project.root_path, filePath), start, end);
      const numbered = slice.lines.map((l, i) => `${start + i}\t${l}`).join('\n');
      const remaining = file.line_count - end;
      const footer = remaining > 0
        ? `\n... [${remaining} more lines — use start_line/end_line to continue, or force=true for the full file]`
        : '';
      return numbered + footer;
    } catch (e) {
      return `Failed: ${(e as Error).message}`;
    }
  },
});

const list_directory = defineTool({
  name: 'list_directory',
  description: 'List files under a path prefix from the index (no disk access). Compact output.',
  inputSchema: {
    type: 'object',
    properties: { project_name: { type: 'string' }, path: { type: 'string' }, depth: { type: 'number' } },
    required: ['project_name'],
  },
  handler: (args, { db }) => {
    const project = resolveProject(db, args.project_name as string);
    const prefix = (args.path as string | undefined) ?? '';
    const depth = (args.depth as number) ?? 2;
    const files = db.listFiles(project.id);
    const baseDepth = prefix ? prefix.split('/').filter(Boolean).length : 0;
    const filtered = files.filter(f => !prefix || f.path.startsWith(prefix));
    const out: string[] = [];
    for (const f of filtered) {
      const parts = f.path.split('/');
      if (parts.length - baseDepth > depth + 1) continue;
      const indent = '  '.repeat(Math.max(0, parts.length - baseDepth - 1));
      out.push(`${indent}${parts[parts.length - 1]} (${f.line_count}L)`);
    }
    return out.slice(0, 200).join('\n') || 'Empty.';
  },
});

const get_recently_modified_files = defineTool({
  name: 'get_recently_modified_files',
  description: 'List recently indexed/modified files.',
  inputSchema: {
    type: 'object',
    properties: { project_name: { type: 'string' }, limit: { type: 'number' } },
    required: ['project_name'],
  },
  handler: (args, { db }) => {
    const project = resolveProject(db, args.project_name as string);
    const limit = (args.limit as number) ?? 20;
    const files = db.listFiles(project.id)
      .sort((a, b) => (b.updated_at || '').localeCompare(a.updated_at || ''))
      .slice(0, limit);
    return files.map(f => `${f.updated_at} ${f.path} (${f.line_count}L)`).join('\n') || 'No files.';
  },
});

const get_dependencies = defineTool({
  name: 'get_dependencies',
  description: 'Get file dependencies (imports)',
  inputSchema: {
    type: 'object',
    properties: { project_name: { type: 'string' }, file_path: { type: 'string' } },
    required: ['project_name', 'file_path'],
  },
  handler: (args, { db }) => {
    const project = resolveProject(db, args.project_name as string);
    const file = db.getFile(project.id, args.file_path as string);
    if (!file) throw new Error(`File "${args.file_path}" not found in index. Use list_directory or search to find the correct path. Do not retry with the same file_path.`);
    const deps = db.getDependencies(file.id);
    return deps.map(d => `${d.dep_type} ${d.import_path}${d.target_file_path ? ` → ${d.target_file_path}` : ''}`).join('\n') || 'No dependencies found.';
  },
});

const get_dependents = defineTool({
  name: 'get_dependents',
  description: 'Get files that depend on a given file',
  inputSchema: {
    type: 'object',
    properties: { project_name: { type: 'string' }, file_path: { type: 'string' } },
    required: ['project_name', 'file_path'],
  },
  handler: (args, { db }) => {
    const project = resolveProject(db, args.project_name as string);
    const file = db.getFile(project.id, args.file_path as string);
    if (!file) throw new Error(`File "${args.file_path}" not found in index. Use list_directory or search to find the correct path. Do not retry with the same file_path.`);
    const deps = db.getDependents(project.id, file.id);
    return deps.map(d => `${d.source_file_path} (${d.import_path})`).join('\n') || 'No dependents found.';
  },
});

export const fileTools: McpTool[] = [
  get_file_structure,
  get_file_skeleton,
  read_file,
  list_directory,
  get_recently_modified_files,
  get_dependencies,
  get_dependents,
];

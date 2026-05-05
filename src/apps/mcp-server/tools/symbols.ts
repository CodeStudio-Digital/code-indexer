import { join } from 'node:path';
import { defineTool, type McpTool } from '../tool.js';
import {
  extractSymbolBody,
  grepInFiles,
  findSymbolDeclLine,
  locateSymbolInFiles,
} from '../../../core/services/code-reader.js';
import type { DBSymbol } from '../../../types.js';
import { withProject } from './_helpers.js';

const get_symbol_details = defineTool({
  name: 'get_symbol_details',
  description: 'Get symbol details by ID',
  inputSchema: {
    type: 'object',
    properties: { symbol_id: { type: 'number' } },
    required: ['symbol_id'],
  },
  handler: (args, { db }) => {
    const sym = db.getSymbolById(args.symbol_id as number);
    if (!sym) throw new Error(`Symbol with id ${args.symbol_id} not found. Use search or get_file_skeleton to find valid symbol IDs. Do not retry with the same symbol_id.`);
    const tags = JSON.parse(sym.tags) as string[];
    const refs = db.getSymbolCallers(sym.project_id, sym.name);
    const rels = db.getSymbolRelations(sym.id);

    const sections = [
      `# ${sym.kind} \`${sym.name}\``,
      `Signature: \`${sym.signature}\``,
      `File: ${sym.file_path}:${sym.line ?? '?'}`,
      sym.parent ? `Parent: ${sym.parent}` : '',
      sym.comment ? `\n## Description\n${sym.comment}` : '',
      tags.length > 0 ? `Tags: ${tags.join(', ')}` : '',
    ].filter(Boolean);

    if (rels.length > 0) {
      sections.push('', '## Relations', rels.map(r => `- ${r.relation_type}: ${r.related_symbol_name}`).join('\n'));
    }
    if (refs.length > 0) {
      sections.push('', '## Referenced by', refs.map(r => `- ${r.referencing_file_path}:${r.line ?? '?'}${r.context ? ` — ${r.context}` : ''}`).join('\n'));
    }
    return sections.join('\n');
  },
});

const get_class_members = defineTool({
  name: 'get_class_members',
  description: 'Get members of a class',
  inputSchema: {
    type: 'object',
    properties: { class_name: { type: 'string' }, project_name: { type: 'string' } },
    required: ['class_name', 'project_name'],
  },
  handler: withProject((args, { db }, project) => {
    const members = db.getClassMembers(args.class_name as string, project.id);
    return members.map(m => `  ${m.kind} ${m.name} — ${m.signature}`).join('\n') || 'No members found.';
  }),
});

const find_references = defineTool({
  name: 'find_references',
  description: 'Find all files that reference a symbol. When the symbol name is ambiguous, the response includes a list of candidate definitions; pass file_path to scope references to a specific definition. Pass format="json" for a structured response.',
  inputSchema: {
    type: 'object',
    properties: {
      project_name: { type: 'string' },
      symbol_name: { type: 'string' },
      file_path: { type: 'string', description: 'Optional, for disambiguation when symbol_name is defined in multiple files' },
      format: { type: 'string', enum: ['text', 'json'] },
    },
    required: ['project_name', 'symbol_name'],
  },
  handler: withProject((args, { db }, project) => {
    const symbolName = args.symbol_name as string;
    const filePath = args.file_path as string | undefined;
    const asJson = args.format === 'json';

    const candidates = db.findSymbolsByName(project.id, symbolName);
    const ambiguous = candidates.length > 1 && !filePath;

    const refs = db.getSymbolCallers(project.id, symbolName);
    if (refs.length > 0) {
      if (asJson) {
        return JSON.stringify({
          symbol_name: symbolName,
          source: 'db',
          ambiguous,
          candidates: ambiguous
            ? candidates.slice(0, 10).map(c => ({
                file_path: c.file_path,
                line: c.line,
                kind: c.kind,
                stable_id: c.stable_id,
              }))
            : undefined,
          total: refs.length,
          references: refs.map(r => ({
            file_path: r.referencing_file_path,
            line: r.line,
            context: r.context,
          })),
        });
      }
      const defBlock: string[] = [];
      if (ambiguous) {
        defBlock.push(`[note] '${symbolName}' is defined in ${candidates.length} files:`);
        for (const c of candidates.slice(0, 10)) {
          defBlock.push(`  - ${c.file_path}:${c.line ?? '?'} [${c.kind}]`);
        }
        defBlock.push('Pass file_path to scope references to a specific definition.');
        defBlock.push('');
      }
      return defBlock.join('\n') + refs.map(r => `${r.referencing_file_path}:${r.line ?? '?'}${r.context ? `: ${r.context}` : ''}`).join('\n');
    }
    // Fallback: grep the project files directly
    const allFiles = db.listFiles(project.id).map(f => f.path);
    const escaped = symbolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(`\\b${escaped}\\b`);
    const hits = grepInFiles(project.root_path, allFiles, pattern, 50);
    if (asJson) {
      return JSON.stringify({
        symbol_name: symbolName,
        source: 'grep_fallback',
        ambiguous,
        total: hits.length,
        references: hits.map(h => ({ file_path: h.file, line: h.line, context: h.text })),
      });
    }
    if (hits.length === 0) return 'No references found.';
    return `[grep fallback — symbol_references DB empty]\n` +
      hits.map(h => `${h.file}:${h.line}: ${h.text}`).join('\n');
  }),
});

const get_hierarchy = defineTool({
  name: 'get_hierarchy',
  description: 'Get class/interface hierarchy (extends, implements, subclasses)',
  inputSchema: {
    type: 'object',
    properties: { project_name: { type: 'string' }, symbol_name: { type: 'string' } },
    required: ['project_name', 'symbol_name'],
  },
  handler: withProject((args, { db }, project) => {
    const hierarchy = db.getSymbolHierarchy(project.id, args.symbol_name as string);
    const lines: string[] = [];
    if (hierarchy.extends_chain.length > 0) lines.push(`Extends: ${hierarchy.extends_chain.join(' → ')}`);
    if (hierarchy.implements_list.length > 0) lines.push(`Implements: ${hierarchy.implements_list.join(', ')}`);
    if (hierarchy.subclasses.length > 0) lines.push(`Subclasses: ${hierarchy.subclasses.join(', ')}`);
    if (hierarchy.implementors.length > 0) lines.push(`Implementors: ${hierarchy.implementors.join(', ')}`);
    return lines.join('\n') || 'No hierarchy information found.';
  }),
});

const find_implementations = defineTool({
  name: 'find_implementations',
  description: 'Find implementations of an interface',
  inputSchema: {
    type: 'object',
    properties: { project_name: { type: 'string' }, interface_name: { type: 'string' } },
    required: ['project_name', 'interface_name'],
  },
  handler: withProject((args, { db }, project) => {
    const impls = db.getImplementors(project.id, args.interface_name as string);
    return impls.map(s => `${s.kind} ${s.name} — ${s.file_path}:${s.line ?? '?'}`).join('\n') || 'No implementations found.';
  }),
});

const trace_usage = defineTool({
  name: 'trace_usage',
  description: 'Trace the full usage tree of a symbol (who calls it, and who calls those callers)',
  inputSchema: {
    type: 'object',
    properties: {
      project_name: { type: 'string' },
      symbol_name: { type: 'string' },
      depth: { type: 'number', description: 'Max depth (default 3)' },
    },
    required: ['project_name', 'symbol_name'],
  },
  handler: withProject((args, { db }, project) => {
    const depth = (args.depth as number) ?? 3;
    const tree = db.traceSymbolUsage(project.id, args.symbol_name as string, depth);

    const formatTree = (callers: typeof tree.callers, indent: string): string => {
      const MAX_CALLERS_PER_NODE = 5;
      const shownCallers = callers.slice(0, MAX_CALLERS_PER_NODE);
      const isTruncated = callers.length > MAX_CALLERS_PER_NODE;

      const result = shownCallers.map(c => {
        const lines = [`${indent}- **${c.file}**${c.line ? `:${c.line}` : ''}`];
        if (c.symbols_in_file.length > 0) {
          lines.push(`${indent}  Symbols here: ${c.symbols_in_file.map(s => `\`${s}\``).join(', ')}`);
        }
        if (c.callers.length > 0) {
          lines.push(`${indent}  Called by:`);
          lines.push(formatTree(c.callers as typeof tree.callers, indent + '    '));
        }
        return lines.join('\n');
      }).join('\n');

      if (isTruncated) {
          return result + `\n${indent}- [... and ${callers.length - MAX_CALLERS_PER_NODE} more callers omitted here to protect context limits. Use find_references on specific parents to drill down.]`;
      }
      return result;
    };

    const sections = [
      `# Usage Tree: \`${tree.symbol}\``,
      tree.defined_in ? `Defined in: ${tree.defined_in}` : 'Definition not found in index',
      '',
    ];
    if (tree.callers.length === 0) {
      sections.push('No usages found.');
    } else {
      sections.push(`## Callers (depth: ${depth})`);
      sections.push(formatTree(tree.callers, ''));
    }
    return sections.join('\n');
  }),
});

const get_symbol_body = defineTool({
  name: 'get_symbol_body',
  description: 'Extract just the body (line range) of a symbol — token-cheap alternative to reading the whole file. In JSON mode, returns ambiguous candidate list when symbol_name matches multiple definitions without file_path. Pass format="json" for a structured response.',
  inputSchema: {
    type: 'object',
    properties: {
      project_name: { type: 'string' },
      symbol_name: { type: 'string' },
      file_path: { type: 'string', description: 'Optional, for disambiguation' },
      format: { type: 'string', enum: ['text', 'json'] },
    },
    required: ['project_name', 'symbol_name'],
  },
  handler: withProject((args, { db }, project) => {
    const symbolName = args.symbol_name as string;
    const filePath = args.file_path as string | undefined;
    const asJson = args.format === 'json';

    let sym: DBSymbol | undefined;
    if (filePath) {
      sym = db.findSymbolByName(project.id, symbolName, { filePath });
    } else {
      const candidates = db.findSymbolsByName(project.id, symbolName);
      if (candidates.length > 1 && asJson) {
        return JSON.stringify({
          error: 'ambiguous',
          symbol_name: symbolName,
          total: candidates.length,
          candidates: candidates.slice(0, 10).map(c => ({
            file_path: c.file_path,
            line: c.line,
            kind: c.kind,
            stable_id: c.stable_id,
          })),
        });
      }
      sym = candidates[0];
    }

    let targetFile: string | null = sym?.file_path ?? filePath ?? null;
    let targetLine: number | null = sym?.line ?? null;
    let usedFallback = false;

    if (targetFile && !targetLine) {
      targetLine = findSymbolDeclLine(join(project.root_path, targetFile), symbolName);
      if (targetLine) usedFallback = true;
    }
    if (!targetFile || !targetLine) {
      const allFiles = db.listFiles(project.id).map(f => f.path);
      const located = locateSymbolInFiles(project.root_path, allFiles, symbolName);
      if (located) {
        targetFile = located.file;
        targetLine = located.line;
        usedFallback = true;
      }
    }
    if (!targetFile || !targetLine) {
      throw new Error(
        `Symbol "${symbolName}" not found. Use search or get_file_skeleton to find the correct symbol name. ` +
        `If you already know the file path but the index is stale, call native read_file({ path, symbol: "${symbolName}" }) — it runs the same regex+brace fallback straight from disk. Do not retry with the same arguments.`,
      );
    }
    try {
      const result = extractSymbolBody(project.root_path, targetFile, targetLine);
      if (asJson) {
        return JSON.stringify({
          symbol_name: symbolName,
          file_path: result.file,
          start_line: result.start_line,
          end_line: result.end_line,
          body: result.body,
          stable_id: sym?.stable_id ?? null,
          used_fallback: usedFallback,
        });
      }
      const note = usedFallback ? ' [regex fallback]' : '';
      return `${result.file}:${result.start_line}-${result.end_line}${note}\n\n${result.body}`;
    } catch (e) {
      const msg = (e as Error).message;
      return asJson
        ? JSON.stringify({ error: 'read_failed', message: msg })
        : `Failed to read body: ${msg}`;
    }
  }),
});

const prepare_edit = defineTool({
  name: 'prepare_edit',
  description: 'One-shot context bundle for editing a symbol: body + callers + neighbors + imports + tests. Replaces 5+ separate calls. Callers are capped by max_callers (default 10) and sorted by proximity (same file > same dir > rest). If the symbol name is ambiguous, returns candidate list — pass file_path to disambiguate. Pass format="json" for a structured response.',
  inputSchema: {
    type: 'object',
    properties: {
      project_name: { type: 'string' },
      symbol_name: { type: 'string' },
      file_path: { type: 'string', description: 'Optional, for disambiguation when symbol_name is not unique' },
      max_callers: { type: 'number', description: 'Max callers listed (default 10)' },
      format: { type: 'string', enum: ['text', 'json'], description: 'Response format (default text)' },
    },
    required: ['project_name', 'symbol_name'],
  },
  handler: withProject((args, { db }, project) => {
    const symbolName = args.symbol_name as string;
    const filePath = args.file_path as string | undefined;
    const maxCallers = (args.max_callers as number) ?? 10;
    const asJson = args.format === 'json';

    let sym = filePath
      ? db.findSymbolByName(project.id, symbolName, { filePath })
      : undefined;
    if (!sym) {
      const candidates = db.findSymbolsByName(project.id, symbolName);
      if (candidates.length === 0) {
        throw new Error(`Symbol "${symbolName}" not found. Use search or get_file_skeleton to find the correct symbol name. Do not retry with the same arguments.`);
      }
      if (candidates.length > 1 && !filePath) {
        if (asJson) {
          return JSON.stringify({
            error: 'ambiguous',
            symbol_name: symbolName,
            total: candidates.length,
            candidates: candidates.slice(0, 10).map(c => ({
              file_path: c.file_path,
              line: c.line,
              kind: c.kind,
              signature: c.signature,
              stable_id: c.stable_id,
            })),
          });
        }
        const list = candidates.slice(0, 10).map(
          c => `  - ${c.file_path}:${c.line ?? '?'} [${c.kind}] ${c.signature || c.name}`
        ).join('\n');
        return [
          `Ambiguous symbol '${symbolName}' — ${candidates.length} matches. Re-run with file_path to disambiguate:`,
          list,
          candidates.length > 10 ? `... and ${candidates.length - 10} more` : ''
        ].filter(Boolean).join('\n');
      }
      sym = candidates[0];
    }

    const sections: string[] = [`=== prepare_edit: ${symbolName} ===`];
    if (sym.stable_id) sections.push(`stable_id: ${sym.stable_id}`);

    if (sym.line) {
      try {
        const body = extractSymbolBody(project.root_path, sym.file_path, sym.line);
        sections.push(`file: ${body.file}:${body.start_line}-${body.end_line}`);
        sections.push('\n[BODY]\n' + body.body);
      } catch { sections.push(`file: ${sym.file_path}:${sym.line}`); }
    }

    const allRefs = db.getSymbolCallers(project.id, symbolName);
    const targetDir = sym.file_path.split('/').slice(0, -1).join('/');
    const proximity = (p: string): number => {
      if (p === sym!.file_path) return 0;
      const dir = p.split('/').slice(0, -1).join('/');
      if (dir === targetDir) return 1;
      return 2;
    };
    const sortedRefs = [...allRefs].sort(
      (a, b) => proximity(a.referencing_file_path) - proximity(b.referencing_file_path)
    );
    const shownRefs = sortedRefs.slice(0, maxCallers);
    const truncatedNote = allRefs.length > maxCallers
      ? ` (showing ${shownRefs.length}/${allRefs.length}, ordered by proximity — use find_references for the full list)`
      : '';
    sections.push(`\n[CALLERS] (${allRefs.length})${truncatedNote}`);
    sections.push(
      shownRefs.map(r => `${r.referencing_file_path}:${r.line ?? '?'}${r.context ? `: ${r.context}` : ''}`).join('\n') || 'none'
    );

    const fileSyms = db.getSymbolsByFile(project.id, sym.file_path);
    const idx = fileSyms.findIndex(s => s.name === sym!.name && s.line === sym!.line);
    const neighbors = idx >= 0 ? fileSyms.slice(Math.max(0, idx - 3), idx + 4) : fileSyms.slice(0, 6);
    sections.push(`\n[NEIGHBORS]`);
    sections.push(neighbors.map(s => {
      const marker = s.name === sym!.name && s.line === sym!.line ? ' <- target' : '';
      return `${String(s.line ?? '?').padStart(5)} ${s.kind} ${s.name}${marker}`;
    }).join('\n'));

    const file = db.getFile(project.id, sym.file_path);
    let imports: string[] = [];
    let testFilePaths: string[] = [];
    if (file) {
      imports = JSON.parse(file.dependencies || '[]') as string[];
      sections.push(`\n[IMPORTS]\n${imports.join(', ') || 'none'}`);

      const dependents = db.getDependents(project.id, file.id);
      const testFiles = dependents.filter(d => {
        const df = db.getFile(project.id, d.source_file_path);
        return df?.is_test === 1;
      });
      testFilePaths = testFiles.slice(0, 5).map(t => t.source_file_path);
      sections.push(`\n[TESTS COVERING] (${testFiles.length})`);
      sections.push(testFilePaths.join('\n') || 'none');
    }

    if (asJson) {
      let body: { file: string; start_line: number; end_line: number; body: string } | null = null;
      if (sym.line) {
        try {
          body = extractSymbolBody(project.root_path, sym.file_path, sym.line);
        } catch { /* ignore */ }
      }
      return JSON.stringify({
        symbol: {
          name: sym.name,
          kind: sym.kind,
          signature: sym.signature,
          file_path: sym.file_path,
          line: sym.line,
          stable_id: sym.stable_id,
        },
        body,
        callers: {
          total: allRefs.length,
          shown: shownRefs.length,
          truncated: allRefs.length > maxCallers,
          items: shownRefs.map(r => ({
            file_path: r.referencing_file_path,
            line: r.line,
            context: r.context,
          })),
        },
        neighbors: neighbors.map(n => ({
          name: n.name,
          kind: n.kind,
          line: n.line,
          is_target: n.name === sym!.name && n.line === sym!.line,
        })),
        imports,
        tests_covering: testFilePaths,
      });
    }

    return sections.join('\n');
  }),
});

const semantic_neighbors = defineTool({
  name: 'semantic_neighbors',
  description: 'Find top-K symbols semantically similar to a given symbol using vector search. Useful for discovering related implementations, helpers, or wrappers — complements grep_code when names differ but behavior is similar. Requires vector coverage (see get_project_pulse).',
  inputSchema: {
    type: 'object',
    properties: {
      symbol_id: { type: 'number', description: 'Seed symbol id. Use search_by_kind or get_file_skeleton to discover ids.' },
      limit: { type: 'number', description: 'Max neighbors to return (default 10)' },
    },
    required: ['symbol_id'],
  },
  handler: async (args, { db, embeddingService, vectorStore }) => {
    const sym = db.getSymbolById(args.symbol_id as number);
    if (!sym) throw new Error(`Symbol with id ${args.symbol_id} not found. Use search or get_file_skeleton to find valid symbol IDs. Do not retry with the same symbol_id.`);

    if (!vectorStore || (embeddingService as { constructor: { name: string } }).constructor.name === 'NullEmbeddingService') {
      return `[unavailable] Vector search is not configured for this project. Use grep_code or find_references instead for ${sym.kind} \`${sym.name}\`.`;
    }

    const project = db.getProject(sym.project_id);
    if (!project) return 'Project not found for this symbol.';

    // Build the query text using the same template the indexer uses for
    // body embeddings — maximizes vector-space proximity to the seed.
    const queryText = `${sym.kind} ${sym.name}\n${sym.signature ?? ''}\n${sym.comment ?? ''}`;
    const { vector } = await embeddingService.embedQuery(queryText);
    if (vector.length === 0) return 'Failed to embed seed symbol.';

    const limit = (args.limit as number) ?? 10;
    // Over-fetch by 2 so we can drop the seed itself and still return `limit`.
    const matches = await vectorStore.search(vector, {
      topK: limit + 2,
      filter: { project_name: project.name, type: 'symbol_body' },
    });

    // If symbol_body coverage is thin, fall back to signature-level matches.
    let usable = matches;
    if (usable.length === 0) {
      usable = await vectorStore.search(vector, {
        topK: limit + 2,
        filter: { project_name: project.name, type: 'symbol' },
      });
    }

    const neighbors: string[] = [];
    for (const m of usable) {
      const refId = m.metadata.ref_id ? parseInt(m.metadata.ref_id, 10) : 0;
      if (!refId || refId === sym.id) continue;
      const n = db.getSymbolById(refId);
      if (!n) continue;
      neighbors.push(`${m.score.toFixed(3)} ${n.file_path}:${n.line ?? '?'} ${n.kind} ${n.name}`);
      if (neighbors.length >= limit) break;
    }

    if (neighbors.length === 0) {
      return `No semantic neighbors found for ${sym.kind} ${sym.name}. Vector coverage may be incomplete — try reindexing.`;
    }

    return [
      `# Semantic neighbors of ${sym.kind} \`${sym.name}\` (${sym.file_path}:${sym.line ?? '?'})`,
      '',
      ...neighbors,
    ].join('\n');
  },
});

export const symbolTools: McpTool[] = [
  get_symbol_details,
  get_class_members,
  find_references,
  get_hierarchy,
  find_implementations,
  trace_usage,
  get_symbol_body,
  prepare_edit,
  semantic_neighbors,
];

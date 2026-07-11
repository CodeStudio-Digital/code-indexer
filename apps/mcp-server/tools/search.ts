import { minimatch } from 'minimatch';
import { glob as fastGlob } from 'glob';
import { defineTool, type McpTool } from '../tool.js';
import { grepInFiles } from '@mcp/services/services/code-reader.js';
import { buildContentMatchQuery } from '@mcp/indexer/search/content-grep.js';
import type { SearchMode, SearchType } from '@mcp/shared/types.js';
import { withProject } from './_helpers.js';
import { renderDegradedTrailer, renderZeroResultDiagnostics } from './search-diagnostics.js';
import { assignWorkspaceSlugs } from '@mcp/shared/utils/workspace-slug.js';

const DISK_FALLBACK_MAX_FILES = 2000;
const DISK_FALLBACK_IGNORE = [
  'node_modules/**',
  '.git/**',
  'dist/**',
  'build/**',
  'out/**',
  '.next/**',
  '.mcp-indexer/**',
  '**/*.min.js',
  '**/*.map',
];

export interface DiskScanSource {
  rootPath: string;
  prefix: string;
}

export async function scanDiskForGrep(
  rootPath: string,
  glob: string | undefined,
  sources?: readonly DiskScanSource[],
): Promise<string[]> {
  const pattern = glob && glob.length > 0 ? glob : '**/*';
  try {
    if (sources && sources.length > 0) {
      const out: string[] = [];
      for (const source of sources) {
        // Scan each DB-authorized real root directly. Prefix after discovery so
        // callers keep the synthetic workspace's path contract without asking
        // glob to follow junctions.
        let matches: string[];
        try {
          matches = await fastGlob('**/*', {
            cwd: source.rootPath,
            nodir: true,
            dot: false,
            absolute: false,
            ignore: DISK_FALLBACK_IGNORE,
          });
        } catch {
          continue; // deleted/unavailable linked project; keep scanning peers
        }
        let accepted = 0;
        for (const match of matches) {
          const rel = match.split('\\').join('/');
          const globalRel = `${source.prefix}/${rel}`;
          if (glob && !minimatch(globalRel, pattern)) continue;
          out.push(globalRel);
          accepted++;
          if (accepted >= DISK_FALLBACK_MAX_FILES) break;
        }
      }
      return out;
    }
    const matches = await fastGlob(pattern, {
      cwd: rootPath,
      nodir: true,
      dot: false,
      absolute: false,
      ignore: DISK_FALLBACK_IGNORE,
    });
    // Normalize to forward slashes (Windows) and cap.
    return matches.slice(0, DISK_FALLBACK_MAX_FILES).map(p => p.split('\\').join('/'));
  } catch {
    return [];
  }
}

const search = defineTool({
  name: 'search',
  description: 'Search files and symbols in a project (FTS + semantic). mode defaults to auto: the planner routes identifier-shaped queries to fast FTS and natural-language queries to hybrid.',
  inputSchema: {
    type: 'object',
    properties: {
      project_name: { type: 'string' },
      query: { type: 'string' },
      mode: { type: 'string', enum: ['auto', 'fts', 'vector', 'hybrid'] },
      type: { type: 'string', enum: ['files', 'symbols', 'all'] },
      limit: { type: 'number' },
    },
    required: ['project_name', 'query'],
  },
  handler: withProject(async (args, { db, hybridSearch }, project) => {
    // 'auto' lets the planner route: identifier-shaped → FTS (~10ms),
    // natural language → hybrid. Forcing 'hybrid' here made every symbol
    // lookup pay HyDE + multi-variant embedding + rerank for nothing.
    const requestedMode = (args.mode as SearchMode) ?? 'auto';
    const { results, diagnostics } = await hybridSearch.searchWithDiag(project.id, project.name, args.query as string, {
      mode: requestedMode,
      type: (args.type as SearchType) ?? 'all',
      limit: (args.limit as number) ?? 20,
    });
    if (results.length === 0) {
      return renderZeroResultDiagnostics(requestedMode, diagnostics, () => ({
        ...db.getEmbeddingCoverage(project.id),
        files_semantic_stale: db.countSemanticStale(project.id),
      }));
    }
    const body = results.map(r => {
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
    }).join('\n\n');
    const trailer = renderDegradedTrailer(diagnostics);
    return trailer ? `${body}\n\n${trailer}` : body;
  }),
});

// `search_concepts` and `search_by_kind` were retired from the MCP surface
// (tool audit 2026-07, docs/audit/TOOL_AUDIT.md): 0 calls in telemetry — the
// `search` planner routes free-text and identifier queries, and grep_code
// covers exact-shape hunts, leaving no niche for the specialized variants.
const grep_code = defineTool({
  name: 'grep_code',
  description: 'Textual search across project files with filters (language/layer/glob). Results capped at max_results (default 20). Use literal=true for exact string matching.',
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
  handler: withProject(async (args, { db }, project) => {
    const pattern = args.pattern as string;
    let literal = args.literal === true;
    const ci = !args.case_sensitive;
    const lang = args.language as string | undefined;
    const layer = args.layer as string | undefined;
    const rawGlob = args.glob as string | undefined;
    // Normalize Windows backslashes — paths in the DB are forward-slash (see
    // scanner normalization), and fast-glob/minimatch expect forward slashes.
    const glob = rawGlob ? rawGlob.replace(/\\/g, '/') : undefined;
    const maxResults = (args.max_results as number) ?? 20;

    let files = db.listFiles(project.id, lang);
    const totalIndexed = files.length;
    if (layer) files = files.filter(f => f.layer === layer);
    if (glob) files = files.filter(f => minimatch(f.path, glob));
    const globMatched = files.length;

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

    // Content-index pre-filter (the IntelliJ word-index): scan bm25-ranked
    // candidate files FIRST and short-circuit when the result cap is already
    // reached — same contract as today (results were capped anyway), ~20-50ms
    // instead of a full read of every indexed file. NOT a complete superset
    // (word index ≠ substring index: literal `Change` hides inside the token
    // `handlechange`), so when the cap isn't reached we FINISH with the
    // remaining files — exactness preserved, the index only buys ordering +
    // early exit.
    const allPaths = files.map(f => f.path);
    let hits: ReturnType<typeof grepInFiles> = [];
    let viaContentIndex = false;
    let scannedAll = false;
    const ftsQuery = process.env.MCP_FTS_CONTENT_GREP !== '0' ? buildContentMatchQuery(pattern, literal) : null;
    if (ftsQuery) {
      try {
        const allowed = new Set(allPaths);
        const candidatePaths = db.searchFileContents(project.id, ftsQuery, 500)
          .map(c => c.path)
          .filter(p => allowed.has(p));
        if (candidatePaths.length > 0) {
          hits = grepInFiles(project.root_path, candidatePaths, re, maxResults);
          if (hits.length >= maxResults) {
            viaContentIndex = true;
            scannedAll = true; // cap reached — nothing more would be returned
          } else {
            const scanned = new Set(candidatePaths);
            hits = hits.concat(grepInFiles(
              project.root_path,
              allPaths.filter(p => !scanned.has(p)),
              re,
              maxResults - hits.length,
            ));
            scannedAll = true;
          }
        }
      } catch {
        // Malformed MATCH / vtab missing (pre-migration DB) — legacy path covers.
      }
    }
    if (!scannedAll) {
      hits = grepInFiles(project.root_path, allPaths, re, maxResults);
    }

    // Disk fallback: when the index can't satisfy the search (empty index,
    // glob filtered everything out, or no hits in indexed set), scan disk
    // directly. Catches files created outside the session or not re-indexed.
    let usedFallback = false;
    let diskScanned = 0;
    if (hits.length === 0) {
      const diskSources = project.is_synthetic
        ? assignWorkspaceSlugs(db.listUnionProjectIds(project.id)).map((p) => ({
            rootPath: p.root_path,
            prefix: p.slug,
          }))
        : undefined;
      const diskFiles = await scanDiskForGrep(project.root_path, glob, diskSources);
      diskScanned = diskFiles.length;
      if (diskFiles.length > 0) {
        hits = grepInFiles(project.root_path, diskFiles, re, maxResults);
        usedFallback = hits.length > 0;
      }
    }

    if (hits.length === 0) {
      const diag = ` [indexed: ${totalIndexed}${glob ? `, glob-matched: ${globMatched}` : ''}, disk-scanned: ${diskScanned}]`;
      return fallbackNote + 'No matches.' + diag;
    }
    const results = hits.map(h => `${h.file}:${h.line}: ${h.text}`).join('\n');
    const capNote = hits.length >= maxResults ? `\n... [capped at ${maxResults} results]` : '';
    const fallbackTag = usedFallback
      ? '\n[note: results from disk fallback — some files may not be indexed yet, consider re-indexing]'
      : viaContentIndex ? '\n[via content-index]' : '';
    return fallbackNote + results + capNote + fallbackTag;
  }),
});

export const searchTools: McpTool[] = [search, grep_code];

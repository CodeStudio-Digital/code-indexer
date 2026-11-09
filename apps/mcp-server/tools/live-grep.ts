import { minimatch } from 'minimatch';
import { boundedGrep } from '@mcp/services/services/bounded-grep.js';
import { discoverLivePaths, type LivePathSource } from '@mcp/indexer/indexer/live-paths.js';
import { buildContentMatchQuery } from '@mcp/indexer/search/content-grep.js';
import { projectIndexIgnorePatterns } from '@mcp/shared/utils/index-ignore.js';
import { languageIdForPath } from '@mcp/shared/utils/language-id.js';
import { assignWorkspaceSlugs } from '@mcp/shared/utils/workspace-slug.js';
import type { Project } from '@mcp/shared/types.js';
import type { ToolContext } from '../context.js';
import type { McpToolResult, McpSourceTruncation } from '../tool.js';

export async function grepProjectCode(args: Record<string, unknown>, { db, signal }: ToolContext, project: Project): Promise<McpToolResult> {
  signal?.throwIfAborted();
  const pattern = String(args.pattern ?? '');
  if (!pattern || pattern.length > 4096) throw new Error('pattern must contain 1–4096 characters');
  let literal = args.literal === true;
  const glob = typeof args.glob === 'string' ? args.glob.replace(/\\/g, '/') : undefined;
  const maxResults = Math.max(1, Math.min(1000, Math.floor(Number(args.max_results) || 20)));
  const lang = typeof args.language === 'string' ? args.language : undefined;
  let fallbackNote = '';
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let re: RegExp;
  try { re = new RegExp(literal ? escape(pattern) : pattern, args.case_sensitive ? '' : 'i'); }
  catch {
    literal = true;
    re = new RegExp(escape(pattern), args.case_sensitive ? '' : 'i');
    fallbackNote = '[note: pattern was not valid regex, searched as literal string]\n';
  }
  const observedAt = new Date().toISOString();
  const revision = db.getStructuralRevision?.(project.id) ?? null;
  const acquired = db.listFilePathsBounded(project.id, lang);
  const indexed = acquired.paths
    .filter(p => !glob || minimatch(p, glob, { dot: true }));
  const sources: LivePathSource[] = project.is_synthetic
    ? assignWorkspaceSlugs(db.listUnionProjectIds(project.id)).map(p => ({ rootPath: p.root_path, prefix: p.slug, ignorePatterns: projectIndexIgnorePatterns(db.getProject(p.project_id)) }))
    : [{ rootPath: project.root_path, prefix: '', ignorePatterns: projectIndexIgnorePatterns(project) }];
  const disk = await discoverLivePaths(sources, { glob, maxFiles: 2000, exclude: new Set(indexed), signal });
  const fresh = disk.paths.filter(p => !lang || languageIdForPath(p) === lang);
  let ordered = [...fresh, ...indexed];
  const fts = buildContentMatchQuery(pattern, literal);
  if (fts) try {
    const priority = db.searchFileContents(project.id, fts, 500).map(c => c.path)
      .filter(p => (!glob || minimatch(p, glob, { dot: true })) && (!lang || languageIdForPath(p) === lang));
    const seen = new Set([...fresh, ...priority]);
    ordered = [...fresh, ...priority, ...indexed.filter(p => !seen.has(p))];
  } catch { /* FTS only orders; current disk text remains authoritative. */ }
  const scan = await boundedGrep({ sources, paths: ordered, pattern: re, maxMatches: maxResults + 1, onePerLine: true, signal });
  const hits = scan.matches.slice(0, maxResults);
  const capped = scan.matches.length > hits.length || scan.truncated;
  const complete = !acquired.truncated && !capped && !disk.truncated && !disk.failedRoots && !scan.skippedFiles && !scan.skippedLines && !scan.changedFiles;
  const sourceTruncations: McpSourceTruncation[] = [];
  if (acquired.truncated) sourceTruncations.push({ technique: 'mcp-grep-index-path-cap', inputSize: acquired.paths.length + 1, inputSizeExact: false, outputSize: acquired.paths.length, unit: 'items', recoverable: false });
  if (capped) sourceTruncations.push({ technique: 'mcp-grep-result-cap', inputSize: scan.matches.length, inputSizeExact: false, outputSize: hits.length, unit: 'items', recoverable: false });
  if (disk.truncated) sourceTruncations.push({ technique: 'mcp-grep-disk-file-scan-cap', inputSize: disk.totalMatches, inputSizeExact: disk.totalMatchesExact, outputSize: disk.paths.length, unit: 'items', recoverable: false });
  if (scan.skippedFiles || scan.skippedLines || disk.failedRoots) sourceTruncations.push({ technique: 'mcp-grep-incomplete-scope', inputSize: ordered.length, inputSizeExact: false, outputSize: scan.examinedFiles, unit: 'items', recoverable: false });
  // Content absence does not prove filename absence. Reuse the already bounded
  // inventory for a few navigation hints; never count these as content hits.
  const matchingPaths = [...new Set(hits.length ? [] : ordered.filter(path => re.test(path)))];
  const pathHints = matchingPaths.slice(0, 5);
  const pathHintsTruncated = matchingPaths.length > pathHints.length;
  if (pathHintsTruncated) sourceTruncations.push({ technique: 'mcp-grep-path-hints-cap', inputSize: matchingPaths.length,
    inputSizeExact: true, outputSize: pathHints.length, unit: 'items', recoverable: false });
  const body = hits.length ? hits.map(h => `${h.file}:${h.line}: ${h.text}`).join('\n')
    : 'No content matches observed for this pattern. This does not establish absence of related code or configuration.';
  const pathNote = pathHints.length
    ? `\nFilename matches (navigation hints, not content hits${pathHintsTruncated ? '; more omitted' : ''}):\n${pathHints.join('\n')}`
    : hits.length ? '' : '\nUse a path/glob search when looking for filenames.';
  const note = capped ? `\n... [showing ${hits.length} results; at least ${scan.matches.length} matched — narrow the pattern or raise max_results]` : '';
  return {
    text: fallbackNote + body + pathNote + note + (complete ? '' : '\n[Partial coverage; absence is not proof. Narrow the scope and retry.]'),
    structuredContent: { hits, pathHints, pathHintsTruncated, freshness: { mode: 'live_disk', observedAt, finishedAt: new Date().toISOString(), structuralRevision: revision, snapshot: false },
      coverage: { complete, indexTruncated: acquired.truncated, indexedFiles: indexed.length, discoveredFiles: fresh.length, examinedFiles: scan.examinedFiles, skippedFiles: scan.skippedFiles, skippedLines: scan.skippedLines, failedRoots: disk.failedRoots, changedFiles: scan.changedFiles },
      absenceConclusive: false },
    ...(sourceTruncations.length ? { sourceTruncations } : {}),
  };
}

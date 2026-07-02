/**
 * Open-tabs source — Copilot's "neighboring tabs" (+~5% acceptance in their
 * A/B): the best 60-line Jaccard window from each other open file of the
 * same language, scored against a reference window around the cursor.
 * Everything reads the server-side document-store mirror; no IO.
 */
import { docsForProject } from '../../../lsp/document-store.js';
import { tabRecency } from './edit-tracker.js';
import { bestWindow, tokenSet } from './jaccard.js';
import { approxTokens, TABS_CAP_TOK, type ContextSnippet, type EngineInput } from './types.js';

/** Reference window: last 30 prefix lines + first 5 suffix lines. */
const REF_PREFIX_LINES = 30;
const REF_SUFFIX_LINES = 5;
const MAX_DOC_LINES = 3000;
const TOP_WINDOWS = 3;

// Token-set cache per (project:file:version) — sliding windows re-tokenize on
// every request otherwise. Bounded FIFO; module-level (dual-factory).
const tokenCache = new Map<string, { lines: string[] }>();
const TOKEN_CACHE_CAP = 24;

function docLines(projectId: number, file: string, version: number, content: string): string[] {
  const key = `${projectId}:${file}:${version}`;
  const hit = tokenCache.get(key);
  if (hit) return hit.lines;
  const lines = content.split('\n', MAX_DOC_LINES);
  tokenCache.set(key, { lines });
  if (tokenCache.size > TOKEN_CACHE_CAP) {
    const oldest = tokenCache.keys().next().value;
    if (oldest !== undefined) tokenCache.delete(oldest);
  }
  return lines;
}

export function openTabSnippets(input: EngineInput): ContextSnippet[] {
  const { projectId, file, language, windows } = input;
  const candidates = docsForProject(projectId)
    .filter((d) => d.file !== file && d.doc.languageId === language);
  if (candidates.length === 0) return [];

  const recency = tabRecency(projectId);
  candidates.sort((a, b) => (recency.get(b.file) ?? 0) - (recency.get(a.file) ?? 0));
  const picked = candidates.slice(0, input.maxTabFiles);

  const refLines = [
    ...windows.prefix.split('\n').slice(-REF_PREFIX_LINES),
    ...windows.suffix.split('\n').slice(0, REF_SUFFIX_LINES),
  ];
  const refSet = tokenSet(refLines);
  if (refSet.size === 0) return [];

  const matches: Array<{ file: string; content: string; score: number }> = [];
  for (const c of picked) {
    const lines = docLines(projectId, c.file, c.doc.version, c.doc.content);
    const match = bestWindow(lines, refSet);
    if (!match || match.score < input.jaccardMinScore) continue;
    matches.push({
      file: c.file,
      content: lines.slice(match.startLine - 1, match.endLine).join('\n'),
      score: match.score,
    });
  }
  matches.sort((a, b) => b.score - a.score);

  const out: ContextSnippet[] = [];
  let used = 0;
  for (const m of matches.slice(0, TOP_WINDOWS)) {
    const tokens = approxTokens(m.content);
    if (used + tokens > TABS_CAP_TOK) continue;
    out.push({ kind: 'open-tab', filePath: m.file, content: m.content, score: m.score, tokens, volatile: false });
    used += tokens;
  }
  return out;
}

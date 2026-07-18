/**
 * `change` — the interrogable diff (Onda 3 do review nativo de IA).
 *
 * Inverts the review paradigm: instead of receiving diff TEXT in a prompt,
 * a code_exec script queries the session's pending change like a database —
 * files, shaped hunks, before/after content and symbol bodies, references of
 * changed symbols, and the deterministically-computed absence report. All
 * responses are plain JSON-serializable values.
 *
 * Reference queries (`callers`/`dependents`/`absences`) delegate to the same
 * nested-tool path every other sandbox call uses, so guards, permissions and
 * telemetry apply unchanged. Diff data comes from the SessionChangesPort on
 * ToolContext (wired in runCoder; absent → no `change` global).
 */
import type { ToolContext } from '@mcp/code-agent/core/tool.js';
import type { FileDiff } from '@mcp/services/services/session-snapshots.js';
import { classifyHunk } from '@mcp/services/services/review-hunk-shape.js';
import {
  buildAbsenceReport,
  type ReviewReferenceHit,
} from '@mcp/services/services/review-absences.js';
import {
  extractSymbolBodyFromContent,
  findSymbolDeclLineFromContent,
} from '@mcp/services/services/code-reader.js';

type CallTool = (name: string, args: Record<string, unknown>) => Promise<string>;

const MAX_SEARCH_HITS = 50;

function normalizePath(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '');
}

function parseRefs(content: string): ReviewReferenceHit[] {
  try {
    const parsed = JSON.parse(content) as {
      references?: Array<{ file_path?: unknown; line?: unknown; context?: unknown }>;
    };
    if (!Array.isArray(parsed.references)) return [];
    return parsed.references
      .filter((r): r is { file_path: string; line?: unknown; context?: unknown } =>
        typeof r?.file_path === 'string' && r.file_path !== '')
      .map((r) => ({
        filePath: r.file_path,
        line: typeof r.line === 'number' && Number.isFinite(r.line) ? r.line : null,
        context: typeof r.context === 'string' ? r.context : null,
      }));
  } catch {
    return [];
  }
}

export function buildChangeSandboxApi(
  port: NonNullable<ToolContext['sessionChanges']>,
  callTool: CallTool,
  projectName: string,
): Record<string, unknown> {
  let diffsPromise: Promise<FileDiff[]> | null = null;
  const diffs = (): Promise<FileDiff[]> => (diffsPromise ??= port.getDiffs());
  const beforeCache = new Map<number, Promise<string | null>>();
  const before = (baselineId: number): Promise<string | null> => {
    let p = beforeCache.get(baselineId);
    if (!p) {
      p = port.getBeforeContent(baselineId);
      beforeCache.set(baselineId, p);
    }
    return p;
  };
  const diffFor = async (path: string): Promise<FileDiff> => {
    const all = await diffs();
    const wanted = normalizePath(path);
    const diff = all.find((d) => normalizePath(d.baseline.filePath) === wanted);
    if (!diff) {
      const known = all.map((d) => d.baseline.filePath).join(', ') || '(none)';
      throw new Error(`change: "${path}" was not changed this session. Changed files: ${known}`);
    }
    return diff;
  };

  return {
    /** One row per changed file: shape counts, added/removed, anchors. */
    files: async () =>
      (await diffs()).map((d) => {
        const shapes: Record<string, number> = {};
        let added = 0;
        let removed = 0;
        for (const hunk of d.hunks) {
          if (hunk.decision !== 'pending') continue;
          const { shape } = classifyHunk(d.baseline.filePath, hunk, d.currentContent);
          shapes[shape] = (shapes[shape] ?? 0) + 1;
          added += hunk.addedCount;
          removed += hunk.removedCount;
        }
        return {
          path: d.baseline.filePath,
          baselineId: d.baseline.id,
          pendingHunks: d.hunks.filter((h) => h.decision === 'pending').length,
          shapes,
          added,
          removed,
          diffDisabled: d.diffDisabled,
        };
      }),

    /** Structured pending hunks of one file (shape-classified). */
    hunks: async (path: unknown) => {
      const diff = await diffFor(String(path ?? ''));
      return diff.hunks
        .filter((h) => h.decision === 'pending')
        .map((h) => ({
          fingerprint: h.fingerprint,
          shape: classifyHunk(diff.baseline.filePath, h, diff.currentContent).shape,
          oldStart: h.oldStart,
          oldLines: h.oldLines,
          newStart: h.newStart,
          newLines: h.newLines,
          lines: h.lines.map((l) => ({
            type: l.type,
            oldLine: l.oldLine ?? null,
            newLine: l.newLine ?? null,
            content: l.content,
          })),
        }));
    },

    /** Full before/after content of one changed file. */
    raw: async (path: unknown) => {
      const diff = await diffFor(String(path ?? ''));
      return {
        before: await before(diff.baseline.id),
        after: diff.currentContent,
      };
    },

    /** Before/after body of one symbol in a changed file. */
    symbol: async (path: unknown, name: unknown) => {
      const diff = await diffFor(String(path ?? ''));
      const symbolName = String(name ?? '');
      const sides: Record<'before' | 'after', string | null> = { before: null, after: null };
      const contents = { before: await before(diff.baseline.id), after: diff.currentContent };
      for (const side of ['before', 'after'] as const) {
        const content = contents[side];
        if (content == null) continue;
        const line = findSymbolDeclLineFromContent(content, symbolName);
        if (line == null) continue;
        sides[side] = extractSymbolBodyFromContent(diff.baseline.filePath, content, line).body;
      }
      return sides;
    },

    /** References to a symbol, via the project reference index. */
    callers: async (symbolName: unknown) =>
      parseRefs(
        await callTool('mcp__find_references', {
          project_name: projectName,
          symbol_name: String(symbolName ?? ''),
          format: 'json',
        }),
      ),

    /** Files that depend on a changed file (raw index answer). */
    dependents: async (path: unknown) =>
      callTool('mcp__get_dependents', {
        project_name: projectName,
        file_path: normalizePath(String(path ?? '')),
      }),

    /** Regex search across the changed files, on either side of the change. */
    search: async (pattern: unknown, opts?: { side?: 'before' | 'after'; flags?: string }) => {
      // 'g'/'y' would make re.test() stateful across lines (lastIndex
      // persists), silently skipping alternate matches — strip them.
      const re = new RegExp(String(pattern ?? ''), (opts?.flags ?? '').replace(/[gy]/g, ''));
      const side = opts?.side ?? 'after';
      const hits: Array<{ path: string; line: number; text: string }> = [];
      for (const diff of await diffs()) {
        const content =
          side === 'after' ? diff.currentContent : await before(diff.baseline.id);
        if (content == null) continue;
        const lines = content.split('\n');
        for (let i = 0; i < lines.length && hits.length < MAX_SEARCH_HITS; i++) {
          if (re.test(lines[i])) {
            hits.push({ path: diff.baseline.filePath, line: i + 1, text: lines[i].trim().slice(0, 200) });
          }
        }
        if (hits.length >= MAX_SEARCH_HITS) break;
      }
      return hits;
    },

    /** Deterministic absence report: untouched references of contract-changed symbols. */
    absences: async () =>
      buildAbsenceReport(await diffs(), {
        // Same 5s-per-symbol budget as the self_review path: an unindexed
        // project falls back to a slow disk grep per lookup, and up to 8
        // symbols are queried — a hung index must not stall the script.
        findReferences: async (symbolName) => {
          const invoke = callTool('mcp__find_references', {
            project_name: projectName,
            symbol_name: symbolName,
            format: 'json',
          });
          const timeout = new Promise<null>((resolve) =>
            setTimeout(() => resolve(null), 5_000).unref?.(),
          );
          const content = await Promise.race([invoke, timeout]);
          return content == null ? [] : parseRefs(content);
        },
      }),
  };
}

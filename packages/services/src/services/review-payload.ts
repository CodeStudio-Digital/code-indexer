/**
 * AI-native payload renderer for the snapshot_review pipeline.
 *
 * Replaces the flat, file-ordered "render every pending hunk" payload with a
 * representation designed for how a reviewer MODEL reads:
 *
 *   - hunks are classified by shape (review-hunk-shape.ts); mechanical hunks
 *     (formatting / imports / consistent renames) collapse into a one-line
 *     summary so the budget is spent on logic;
 *   - files are emitted as CHAPTERS in dependency (topological) order —
 *     definitions before their uses — computed from the changed files' own
 *     import statements (pure text scan of FileDiff.currentContent, no index);
 *   - the char cap becomes a managed budget with DECLARED degradation: test
 *     and config hunks get trimmed/summarized before logic is ever touched,
 *     and everything elided or trimmed is listed in a BUDGET section instead
 *     of a silent tail cut.
 *
 * Pure over FileDiff[] — no fs, DB, or model access — so both the pipeline
 * and future bundle builders can share it.
 */
import type { FileDiff } from './session-snapshots.js';
import { classifyHunk, isMechanicalShape, type HunkShape } from './review-hunk-shape.js';

export interface ReviewPayload {
  text: string;
  pendingHunks: number;
}

export interface ReviewPayloadOptions {
  maxChars?: number;
}

const DEFAULT_MAX_CHARS = 60_000;
const TRIMMED_HUNK_LINES = 30;
const IMPORT_SCAN_CHARS = 30_000;
const IMPORT_SPEC_RE = /(?:from|import)\s+['"]([^'"]+)['"]|require(?:_once)?\s*\(\s*['"]([^'"]+)['"]/g;

type PendingHunk = FileDiff['hunks'][number];

function linePrefix(type: 'context' | 'add' | 'remove'): string {
  return type === 'add' ? '+' : type === 'remove' ? '-' : ' ';
}

function hunkHeader(diff: FileDiff, hunk: PendingHunk): string {
  return [
    `file=${diff.baseline.filePath}`,
    `baselineId=${diff.baseline.id}`,
    `hunkFingerprint=${hunk.fingerprint}`,
    `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
  ].join(' ');
}

function renderHunk(diff: FileDiff, hunk: PendingHunk, maxLines?: number): string {
  const rendered = hunk.lines.map((line) => {
    const oldPart = line.oldLine == null ? ' ' : String(line.oldLine);
    const newPart = line.newLine == null ? ' ' : String(line.newLine);
    return `${oldPart.padStart(5)} ${newPart.padStart(5)} ${linePrefix(line.type)}${line.content}`;
  });
  const body =
    maxLines != null && rendered.length > maxLines
      ? [...rendered.slice(0, maxLines), `... [trimmed ${rendered.length - maxLines} more lines — see BUDGET]`]
      : rendered;
  return `${hunkHeader(diff, hunk)}\n${body.join('\n')}`;
}

function mechanicalSummary(diff: FileDiff, hunk: PendingHunk, shape: HunkShape, detail?: string): string {
  const suffix = detail ? ` (${detail})` : '';
  return (
    `MECHANICAL ${hunkHeader(diff, hunk)} kind=${shape}${suffix} ` +
    `+${hunk.addedCount}/-${hunk.removedCount} — body elided; flag only if this summary itself looks wrong`
  );
}

/** Strip the extension and normalize slashes so import specs match paths. */
function pathKey(p: string): string {
  return p.replace(/\\/g, '/').replace(/\.[^/.]+$/, '');
}

function resolveRelative(fromFile: string, spec: string): string | null {
  if (!spec.startsWith('.')) return null;
  const parts = fromFile.replace(/\\/g, '/').split('/').slice(0, -1);
  for (const seg of spec.split('/')) {
    if (seg === '.' || seg === '') continue;
    if (seg === '..') parts.pop();
    else parts.push(seg);
  }
  return pathKey(parts.join('/'));
}

/**
 * Dependency order over the changed files: if A imports B (both changed),
 * B's chapter comes first. Layered Kahn walk, stable within a layer; a cycle
 * falls back to the incoming order for the files still unplaced.
 */
function orderDiffs(diffs: FileDiff[]): { order: number[]; uses: Map<number, Set<number>> } {
  // Extensionless keys can collide (Button.tsx + Button.css). An ambiguous
  // key yields NO edge — falling back to incoming order beats pointing a
  // "[uses]" annotation at the wrong file.
  const keyToIdx = new Map<string, number>();
  const ambiguous = new Set<string>();
  const register = (key: string, i: number): void => {
    if (ambiguous.has(key)) return;
    const existing = keyToIdx.get(key);
    if (existing != null && existing !== i) {
      keyToIdx.delete(key);
      ambiguous.add(key);
      return;
    }
    keyToIdx.set(key, i);
  };
  diffs.forEach((d, i) => {
    const key = pathKey(d.baseline.filePath);
    register(key, i);
    if (key.endsWith('/index')) register(key.slice(0, -'/index'.length), i);
  });
  const uses = new Map<number, Set<number>>();
  diffs.forEach((d, i) => {
    if (!d.currentContent) return;
    const set = new Set<number>();
    for (const m of d.currentContent.slice(0, IMPORT_SCAN_CHARS).matchAll(IMPORT_SPEC_RE)) {
      const resolved = resolveRelative(d.baseline.filePath, m[1] ?? m[2] ?? '');
      if (resolved == null) continue;
      const j = keyToIdx.get(resolved) ?? keyToIdx.get(`${resolved}/index`);
      if (j != null && j !== i) set.add(j);
    }
    if (set.size) uses.set(i, set);
  });
  const placed = new Set<number>();
  const order: number[] = [];
  while (order.length < diffs.length) {
    let advanced = false;
    for (let i = 0; i < diffs.length; i++) {
      if (placed.has(i)) continue;
      const deps = uses.get(i);
      if (!deps || [...deps].every((j) => placed.has(j))) {
        placed.add(i);
        order.push(i);
        advanced = true;
      }
    }
    if (!advanced) {
      for (let i = 0; i < diffs.length; i++) {
        if (!placed.has(i)) {
          placed.add(i);
          order.push(i);
        }
      }
    }
  }
  return { order, uses };
}

interface Item {
  filePath: string;
  fingerprint: string;
  shape: HunkShape;
  mode: 'full' | 'trimmed' | 'summary';
  render: () => string;
  fullText: string;
  trimmedText: string;
  summaryText: string;
}

export function renderReviewPayload(
  diffs: FileDiff[],
  opts: ReviewPayloadOptions = {},
): ReviewPayload {
  const maxChars = opts.maxChars ?? DEFAULT_MAX_CHARS;
  const { order, uses } = orderDiffs(diffs);
  const chapterOf = new Map<number, number>();
  order.forEach((diffIdx, pos) => chapterOf.set(diffIdx, pos + 1));

  let pendingHunks = 0;
  const shapeCounts = new Map<HunkShape, number>();
  const chapters: Array<{ header: string; items: Item[] }> = [];

  for (const diffIdx of order) {
    const diff = diffs[diffIdx];
    const chapter = chapterOf.get(diffIdx)!;
    const deps = [...(uses.get(diffIdx) ?? [])]
      .map((j) => chapterOf.get(j)!)
      .sort((a, b) => a - b);
    const usesNote = deps.length ? ` [uses: ${deps.map((c) => `ch.${c}`).join(', ')}]` : '';
    if (diff.diffDisabled) {
      chapters.push({
        header: `CHAPTER ${chapter}/${order.length}: ${diff.baseline.filePath} baselineId=${diff.baseline.id} — diff disabled (oversized/binary)`,
        items: [],
      });
      continue;
    }
    const items: Item[] = [];
    for (const hunk of diff.hunks) {
      if (hunk.decision !== 'pending') continue;
      pendingHunks++;
      const cls = classifyHunk(diff.baseline.filePath, hunk, diff.currentContent);
      shapeCounts.set(cls.shape, (shapeCounts.get(cls.shape) ?? 0) + 1);
      const summaryText = mechanicalSummary(
        diff, hunk, cls.shape, cls.rename ? `${cls.rename.from} → ${cls.rename.to}` : undefined,
      );
      const item: Item = {
        filePath: diff.baseline.filePath,
        fingerprint: hunk.fingerprint,
        shape: cls.shape,
        mode: isMechanicalShape(cls.shape) ? 'summary' : 'full',
        fullText: renderHunk(diff, hunk),
        trimmedText: renderHunk(diff, hunk, TRIMMED_HUNK_LINES),
        summaryText,
        render() {
          return this.mode === 'summary' ? this.summaryText : this.mode === 'trimmed' ? this.trimmedText : this.fullText;
        },
      };
      items.push(item);
    }
    chapters.push({ header: `CHAPTER ${chapter}/${order.length}: ${diff.baseline.filePath}${usesNote}`, items });
  }

  const allItems = chapters.flatMap((c) => c.items);
  const totalChars = (): number =>
    chapters.reduce(
      (sum, c) => sum + c.header.length + 2 + c.items.reduce((s, it) => s + it.render().length + 2, 0),
      0,
    );

  // Managed degradation, cheapest information loss first. Every step is
  // recorded and declared in the BUDGET section below.
  const trimmed: Item[] = [];
  const summarized: Item[] = [];
  const degrade = (candidates: Item[], to: 'trimmed' | 'summary', log: Item[]): void => {
    const byCost = [...candidates].sort((a, b) => b.render().length - a.render().length);
    for (const item of byCost) {
      if (totalChars() <= maxChars) return;
      const next = to === 'trimmed' ? item.trimmedText : item.summaryText;
      if (next.length >= item.render().length) continue;
      item.mode = to;
      log.push(item);
    }
  };
  if (totalChars() > maxChars) {
    degrade(allItems.filter((i) => (i.shape === 'test' || i.shape === 'config') && i.mode === 'full'), 'trimmed', trimmed);
    degrade(allItems.filter((i) => (i.shape === 'test' || i.shape === 'config') && i.mode !== 'summary'), 'summary', summarized);
    // Logic is last and degrades from the TAIL of the chapter order, so the
    // dependency-first narrative survives as long as possible. Two waves:
    // everything gets trimmed before ANYTHING logic is fully elided.
    for (const wave of ['trimmed', 'summary'] as const) {
      for (const item of [...allItems].reverse()) {
        if (totalChars() <= maxChars) break;
        if (item.shape !== 'logic' || item.mode === 'summary') continue;
        if (wave === 'trimmed') {
          if (item.mode === 'full' && item.trimmedText.length < item.fullText.length) {
            item.mode = 'trimmed';
            trimmed.push(item);
          }
          continue;
        }
        item.mode = 'summary';
        summarized.push(item);
      }
    }
  }

  const mechanicalCount = allItems.filter((i) => isMechanicalShape(i.shape)).length;
  const budgetLines: string[] = [];
  if (mechanicalCount > 0) {
    budgetLines.push(`- ${mechanicalCount} mechanical hunk(s) (formatting/imports/renames) shown as one-line summaries`);
  }
  if (trimmed.length > 0) {
    budgetLines.push(
      `- trimmed to ${TRIMMED_HUNK_LINES} lines: ${trimmed.map((i) => `${i.filePath}#${i.fingerprint.slice(0, 8)}`).join(', ')}`,
    );
  }
  if (summarized.length > 0) {
    budgetLines.push(
      `- elided over budget (ask for a re-review focused on these if needed): ${summarized
        .map((i) => `${i.filePath}#${i.fingerprint.slice(0, 8)}`)
        .join(', ')}`,
    );
  }

  const counts = [...shapeCounts.entries()].map(([shape, n]) => `${n} ${shape}`).join(', ');
  const preamble =
    `Payload: ${order.length} file(s), ${pendingHunks} pending hunk(s) (${counts || 'none'}). ` +
    'Chapters are dependency-ordered: definitions come before their uses.';
  const sections = [
    preamble,
    ...chapters.map((c) => [c.header, ...c.items.map((i) => i.render())].join('\n\n')),
  ];
  if (budgetLines.length > 0) {
    sections.push(['BUDGET (payload degradation — declared, not silent):', ...budgetLines].join('\n'));
  }
  let text = sections.join('\n\n');
  // Absolute ceiling: totalChars() approximates (preamble/BUDGET not counted)
  // and the summary-only floor of a huge session can still exceed the budget.
  // maxChars is a promise to the model call — enforce it, declared.
  const HARD_CAP_SLACK = 2_000;
  if (text.length > maxChars + HARD_CAP_SLACK) {
    text =
      text.slice(0, maxChars) +
      `\n\n[HARD TRUNCATED at ${maxChars} chars — everything after this point was cut; ` +
      'treat unlisted files/hunks as NOT reviewed]';
  }
  return { text, pendingHunks };
}

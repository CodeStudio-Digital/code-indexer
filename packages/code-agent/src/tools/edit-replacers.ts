/**
 * Cascading replacer strategies for edit_file.
 *
 * Ported from opencode (sst/opencode, packages/opencode/src/tool/edit.ts) and
 * adapted to our simpler "apply first successful unique match" contract.
 *
 * Each replacer takes the full file content and the desired old_string, and
 * returns candidate hit ranges expressed as [startIdx, endIdx) on the raw
 * character string, so the caller can replace them uniformly regardless of
 * whether the strategy was character-based or line-based.
 */

export interface ReplacerHit {
  /** Character index (inclusive) where the match starts in the original content. */
  start: number;
  /** Character index (exclusive) where the match ends in the original content. */
  end: number;
}

export type Replacer = (content: string, oldString: string) => ReplacerHit[];

// ---------- character utilities ----------

function lineStartOffsets(content: string): number[] {
  const offsets = [0];
  for (let i = 0; i < content.length; i++) {
    if (content[i] === '\n') offsets.push(i + 1);
  }
  return offsets;
}

function rangeFromLines(
  content: string,
  lineOffsets: number[],
  startLine: number,
  endLineExclusive: number
): ReplacerHit {
  const start = lineOffsets[startLine];
  // end is the start of the line after the last matched line, minus trailing
  // newline trimming handled by callers.
  const endOffset =
    endLineExclusive < lineOffsets.length ? lineOffsets[endLineExclusive] : content.length;
  // Strip the newline that belongs to the last matched line so replacement
  // doesn't gobble the separator.
  let end = endOffset;
  if (end > 0 && content[end - 1] === '\n') end -= 1;
  if (end > 0 && content[end - 1] === '\r') end -= 1;
  return { start, end };
}

function splitLines(s: string): string[] {
  // Preserve empty trailing line when the input ends with a newline by NOT
  // adding it — we want N lines for N line-terminators + (possibly) a final
  // chunk. Using a simple split handles this.
  return s.replace(/\r\n?/g, '\n').split('\n');
}

function stripCommonIndent(lines: string[]): { stripped: string[]; indent: number } {
  let min = Infinity;
  for (const l of lines) {
    if (l.trim().length === 0) continue;
    const m = l.match(/^[ \t]*/);
    const n = m ? m[0].length : 0;
    if (n < min) min = n;
  }
  if (!isFinite(min) || min === 0) return { stripped: lines.slice(), indent: 0 };
  return { stripped: lines.map((l) => (l.length >= min ? l.slice(min) : l)), indent: min };
}

// ---------- replacers ----------

/**
 * Normalizes typographic (curly/smart) quotes to straight ASCII quotes in both
 * the content and the needle, then matches character ranges. Covers the common
 * LLM limitation of outputting straight quotes when the file uses curly quotes
 * (or vice-versa).
 */
export const quoteNormalizedReplacer: Replacer = (content, oldString) => {
  const norm = (s: string): string =>
    s
      .replace(/[\u2018\u2019\u201A\u201B]/g, "'")
      .replace(/[\u201C\u201D\u201E\u201F]/g, '"');
  const normContent = norm(content);
  const normOld = norm(oldString);
  // If normalization didn't change anything, skip (exact match already tried).
  if (normOld === oldString && normContent === content) return [];
  const hits: ReplacerHit[] = [];
  let idx = 0;
  while ((idx = normContent.indexOf(normOld, idx)) !== -1) {
    hits.push({ start: idx, end: idx + normOld.length });
    idx += normOld.length;
  }
  return hits;
};

/**
 * Unescapes literal backslash sequences in the needle (`\\n`, `\\t`, `\\r`,
 * `\\\\`, `\\'`, `\\"`) and tries an exact match. Covers the common LLM bug
 * of emitting a double-escaped old_string.
 */
export const escapeNormalizedReplacer: Replacer = (content, oldString) => {
  const unescaped = oldString
    .replace(/\\\\/g, '\x00')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\r/g, '\r')
    .replace(/\\'/g, "'")
    .replace(/\\"/g, '"')
    .replace(/\x00/g, '\\');
  if (unescaped === oldString) return [];
  const hits: ReplacerHit[] = [];
  let idx = 0;
  while ((idx = content.indexOf(unescaped, idx)) !== -1) {
    hits.push({ start: idx, end: idx + unescaped.length });
    idx += unescaped.length;
  }
  return hits;
};

/**
 * Line-based match that tolerates the LLM omitting or adding a uniform amount
 * of leading indentation. Strips the minimum common indent from old_string,
 * then for each window of the same line count in content, strips the window's
 * own minimum indent and compares.
 */
export const indentationFlexibleReplacer: Replacer = (content, oldString) => {
  const oldLines = splitLines(oldString);
  if (oldLines.length === 0) return [];
  // Drop a trailing empty line that comes from a final newline — it would
  // inflate the window size by 1.
  const trimmed = oldLines[oldLines.length - 1] === '' ? oldLines.slice(0, -1) : oldLines;
  if (trimmed.length === 0) return [];
  const { stripped: oldStripped } = stripCommonIndent(trimmed);
  const oldJoined = oldStripped.join('\n');

  const contentLines = splitLines(content);
  const lineOffsets = lineStartOffsets(content);
  const hits: ReplacerHit[] = [];
  for (let i = 0; i + trimmed.length <= contentLines.length; i++) {
    const window = contentLines.slice(i, i + trimmed.length);
    const { stripped } = stripCommonIndent(window);
    if (stripped.join('\n') === oldJoined) {
      hits.push(rangeFromLines(content, lineOffsets, i, i + trimmed.length));
    }
  }
  return hits;
};

/**
 * The full cascade, in order of strictness. Each entry has a label that is
 * surfaced back to the LLM on success so it can learn what drift it
 * introduced.
 */
export const CASCADING_REPLACERS: Array<{ label: string; run: Replacer }> = [
  { label: 'quote normalized', run: quoteNormalizedReplacer },
  { label: 'escape normalized', run: escapeNormalizedReplacer },
  { label: 'indentation flexible', run: indentationFlexibleReplacer },
];

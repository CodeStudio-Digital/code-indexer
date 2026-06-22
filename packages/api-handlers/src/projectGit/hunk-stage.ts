/**
 * Partial-hunk staging support — pure patch surgery, no git/process here so
 * it's unit-testable without an ABI native module.
 *
 * Given the unified diff of ONE file (`git diff --no-color -- <path>`,
 * worktree↔index) and a 1-based line range on the NEW (working-tree) side,
 * `selectHunks` rebuilds a patch carrying only the hunks that overlap that
 * range. `git apply --cached --recount` then stages exactly those hunks —
 * the engine behind the gutter's "stage / commit this block" action.
 *
 * Why the new-side range maps cleanly: the editor's change blocks are
 * computed HEAD↔buffer, but once the buffer is flushed to disk
 * worktree == buffer, so the NEW-side line numbers of the staging diff
 * (worktree↔index) match the block's current line numbers regardless of
 * what is already staged.
 */

/** Parsed `@@ -oldStart,oldCount +newStart,newCount @@` header. */
export interface HunkHeader {
  newStart: number;
  newCount: number;
}

const HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

export function parseHunkHeader(line: string): HunkHeader | null {
  const m = HUNK_RE.exec(line);
  if (!m) return null;
  const newStart = Number(m[1]);
  const newCount = m[2] === undefined ? 1 : Number(m[2]);
  return { newStart, newCount };
}

/** Inclusive new-side line span a hunk touches; `+c,0` (pure deletion) → [c,c]. */
function hunkRange(h: HunkHeader): [number, number] {
  if (h.newCount <= 0) return [h.newStart, h.newStart];
  return [h.newStart, h.newStart + h.newCount - 1];
}

function overlaps(a: [number, number], b: [number, number]): boolean {
  return a[0] <= b[1] && b[0] <= a[1];
}

/**
 * Rebuild a single-file patch keeping only hunks whose new-side range
 * overlaps `[newStart, newEnd]`. Returns null when the patch has no header,
 * no hunks, or none overlap (the caller surfaces "nothing to stage"). The
 * header (everything before the first `@@`) is preserved verbatim, so binary
 * patches — which have no `@@` — yield null.
 */
export function selectHunks(patch: string, newStart: number, newEnd: number): string | null {
  const lines = patch.split('\n');
  let firstHunk = lines.findIndex((l) => l.startsWith('@@'));
  if (firstHunk === -1) return null;
  const header = lines.slice(0, firstHunk);

  const kept: string[] = [];
  let i = firstHunk;
  const want: [number, number] = [newStart, newEnd];
  while (i < lines.length) {
    if (!lines[i].startsWith('@@')) {
      i++;
      continue;
    }
    const head = parseHunkHeader(lines[i]);
    // Body = lines until the next hunk header (or EOF).
    let j = i + 1;
    while (j < lines.length && !lines[j].startsWith('@@')) j++;
    if (head && overlaps(hunkRange(head), want)) {
      kept.push(lines[i], ...lines.slice(i + 1, j));
    }
    i = j;
  }
  if (kept.length === 0) return null;
  return [...header, ...kept].join('\n') + '\n';
}

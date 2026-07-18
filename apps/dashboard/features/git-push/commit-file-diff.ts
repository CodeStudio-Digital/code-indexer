import { parseDiff, type ChangeData } from 'react-diff-view';

export type CommitDiffRow =
  | { kind: 'hunk'; key: string; content: string }
  | { kind: 'meta'; key: string; content: string }
  | {
      kind: 'line';
      key: string;
      type: 'insert' | 'delete' | 'normal';
      content: string;
      oldLine: number | null;
      newLine: number | null;
      tokenIndex: number;
    };

function lineNumbers(change: ChangeData): { oldLine: number | null; newLine: number | null } {
  if (change.type === 'insert') return { oldLine: null, newLine: change.lineNumber };
  if (change.type === 'delete') return { oldLine: change.lineNumber, newLine: null };
  return { oldLine: change.oldLineNumber, newLine: change.newLineNumber };
}

function fallbackRows(patch: string): CommitDiffRow[] {
  const rows: CommitDiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  let tokenIndex = 0;
  let inHunk = false;
  patch.split(/\r?\n/).forEach((line, index) => {
    const header = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (header) {
      oldLine = Number(header[1]);
      newLine = Number(header[2]);
      inHunk = true;
      rows.push({ kind: 'hunk', key: `fallback-hunk:${index}`, content: line });
      return;
    }
    if (!inHunk) {
      if (line && !line.startsWith('diff --git') && !line.startsWith('index ') && !line.startsWith('--- ') && !line.startsWith('+++ ')) {
        rows.push({ kind: 'meta', key: `fallback-meta:${index}`, content: line });
      }
      return;
    }
    if (line.startsWith('\\ No newline')) {
      rows.push({ kind: 'meta', key: `fallback-meta:${index}`, content: line });
      return;
    }
    const type = line.startsWith('+') ? 'insert' : line.startsWith('-') ? 'delete' : 'normal';
    const currentOld = type === 'insert' ? null : oldLine++;
    const currentNew = type === 'delete' ? null : newLine++;
    rows.push({
      kind: 'line',
      key: `fallback-line:${index}`,
      type,
      content: /^[+\- ]/.test(line) ? line.slice(1) : line,
      oldLine: currentOld,
      newLine: currentNew,
      tokenIndex: tokenIndex++,
    });
  });
  return rows;
}

/** Convert a unified patch into the flat row model consumed by the virtual list. */
export function buildCommitDiffRows(patch: string): CommitDiffRow[] {
  try {
    const files = parseDiff(patch);
    const rows: CommitDiffRow[] = [];
    let tokenIndex = 0;
    files.forEach((file, fileIndex) => {
      file.hunks.forEach((hunk, hunkIndex) => {
        rows.push({
          kind: 'hunk',
          key: `hunk:${fileIndex}:${hunkIndex}:${hunk.oldStart}:${hunk.newStart}`,
          content: hunk.content,
        });
        hunk.changes.forEach((change, changeIndex) => {
          const numbers = lineNumbers(change);
          rows.push({
            kind: 'line',
            key: `line:${fileIndex}:${hunkIndex}:${changeIndex}`,
            type: change.type,
            content: change.content,
            ...numbers,
            tokenIndex: tokenIndex++,
          });
        });
      });
    });
    return rows.length ? rows : fallbackRows(patch);
  } catch {
    return fallbackRows(patch);
  }
}

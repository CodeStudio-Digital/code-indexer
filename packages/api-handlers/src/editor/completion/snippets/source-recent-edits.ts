/**
 * Recent-edits source — excerpts of the CURRENT buffer around the spans the
 * user recently edited (edit-tracker ring). Shows the model what the user is
 * actively building across files, the way Continue's recentlyEditedRanges and
 * Cursor's diff-history do. Excerpts re-read the live document so they never
 * show stale text.
 */
import { getDoc } from '../../../lsp/document-store.js';
import { recentEdits } from './edit-tracker.js';
import { approxTokens, EDITS_CAP_TOK, type ContextSnippet, type EngineInput } from './types.js';

const MAX_ENTRIES = 6;
const PAD_LINES = 3;

export function recentEditSnippets(input: EngineInput): ContextSnippet[] {
  const { projectId, file, position, windows } = input;
  // The trimmed prompt window is already in the prompt — exclude same-file
  // edits that fall inside it.
  const prefixLines = windows.prefix.split('\n').length;
  const suffixLines = windows.suffix.split('\n').length;
  const windowStart = Math.max(1, position.line - prefixLines + 1);
  const windowEnd = position.line + suffixLines;

  const entries = recentEdits(projectId, file, [windowStart, windowEnd]).slice(0, MAX_ENTRIES);
  const out: ContextSnippet[] = [];
  let used = 0;
  for (const [i, en] of entries.entries()) {
    const doc = getDoc(projectId, en.file);
    if (!doc) continue;
    const lines = doc.content.split('\n');
    const start = Math.max(0, en.startLine - 1 - PAD_LINES);
    const end = Math.min(lines.length, en.endLine + PAD_LINES);
    const content = lines.slice(start, end).join('\n').trim();
    if (!content) continue;
    const tokens = approxTokens(content);
    if (used + tokens > EDITS_CAP_TOK) break;
    // Most recent edit scores highest (entries arrive most-recent-first).
    out.push({
      kind: 'recent-edit', filePath: en.file, content, score: 1 - i / MAX_ENTRIES, tokens, volatile: false,
    });
    used += tokens;
  }
  return out;
}

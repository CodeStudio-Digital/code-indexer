/**
 * Context builder for the snapshot_review pipeline.
 *
 * Produces the optional "Context" section prepended to the reviewer prompt:
 * the enclosing function/class of each pending hunk plus the caller-supplied
 * task intent and author focus. Symbol bodies come from the SAME on-disk
 * content the hunks were computed against (`FileDiff.currentContent`), so
 * the line numbers always agree with the hunks — the builder is pure over
 * `FileDiff[]`, no fs/DB access.
 *
 * Everything here is advisory context for the reviewer model; the prompt
 * instructs it to never flag lines that only appear here (see
 * snapshot-review-prompt.ts). Findings still point exclusively at diff lines.
 */
import type { FileDiff } from './session-snapshots.js';
import { extractSymbolBodyFromContent, findEnclosingDeclLine } from './code-reader.js';

/** Max rendered lines per enclosing symbol body. */
export const MAX_SYMBOL_LINES = 120;
/** Max chars for the whole "Enclosing code" section. */
export const MAX_SYMBOLS_CHARS = 24_000;
/** Max chars for the author-supplied focus note (1-3 sentences). */
export const MAX_FOCUS_CHARS = 600;
/** Max chars for the session-intent block (title + first message + tasks). */
export const MAX_INTENT_CHARS = 2_500;
/** Hard cap for the final assembled context text. */
export const MAX_CONTEXT_CHARS = 30_000;
/** Skip enclosing-symbol extraction for files bigger than this (split cost). */
const MAX_SCAN_CHARS = 800_000;

function cap(text: string, max: number): string {
  if (text.length <= max) return text;
  const marker = '\n... [truncated]';
  return text.slice(0, Math.max(0, max - marker.length)) + marker;
}

/**
 * Extract the enclosing symbol (function/class body) for every pending hunk.
 * Dedups when several hunks land in the same symbol, skips symbols already
 * fully visible inside the hunk's rendered window, and never throws — a
 * single unreadable file must not kill the review.
 */
export function buildEnclosingSymbolContext(diffs: FileDiff[]): string | null {
  const chunks: string[] = [];
  const seen = new Set<string>();
  let total = 0;
  let omitted = false;

  outer: for (const diff of diffs) {
    const content = diff.currentContent;
    if (diff.diffDisabled || content == null || content.length > MAX_SCAN_CHARS) continue;
    for (const hunk of diff.hunks) {
      if (hunk.decision !== 'pending') continue;
      try {
        // Anchor on the first added line (falls back to the hunk's new-side
        // start for pure removals), then walk back to the enclosing decl.
        const anchor =
          hunk.lines.find((l) => l.type === 'add' && l.newLine != null)?.newLine ?? hunk.newStart;
        const decl = findEnclosingDeclLine(content, anchor);
        const sym = extractSymbolBodyFromContent(diff.baseline.filePath, content, decl);

        const key = `${diff.baseline.filePath}:${sym.start_line}`;
        if (seen.has(key)) continue;
        seen.add(key);

        // The hunk's own window (with its context lines) already shows the
        // whole symbol — repeating it would only spend tokens.
        if (sym.start_line >= hunk.newStart && sym.end_line <= hunk.newStart + hunk.newLines - 1) {
          continue;
        }

        const bodyLines = sym.body.split('\n');
        const body =
          bodyLines.length > MAX_SYMBOL_LINES
            ? bodyLines.slice(0, MAX_SYMBOL_LINES).join('\n') + '\n... [symbol truncated]'
            : sym.body;

        const chunk = `file=${diff.baseline.filePath} enclosing symbol lines ${sym.start_line}-${sym.end_line}:\n${body}`;
        if (total + chunk.length > MAX_SYMBOLS_CHARS) {
          omitted = true;
          break outer;
        }
        chunks.push(chunk);
        total += chunk.length + 2;
      } catch {
        /* best-effort per hunk */
      }
    }
  }

  if (omitted && chunks.length) chunks.push('... [more symbols omitted]');
  return chunks.length ? chunks.join('\n\n') : null;
}

export interface ReviewContextParts {
  /** Author note from the `self_review` tool's `focus` param. */
  focus?: string | null;
  /** Session intent (title + original request + task list), built by the entrypoint. */
  intent?: string | null;
  /** Output of `buildEnclosingSymbolContext`. */
  symbols?: string | null;
}

/**
 * Assemble the final context text (section order: task context, author
 * focus, enclosing code). Returns null when every part is empty so callers
 * can keep the no-context prompt byte-identical to the legacy one.
 */
export function formatReviewContext(parts: ReviewContextParts): string | null {
  const sections: string[] = [];
  const intent = parts.intent?.trim();
  if (intent) sections.push('## Task context\n' + cap(intent, MAX_INTENT_CHARS));
  const focus = parts.focus?.trim();
  if (focus) sections.push('## Author focus\n' + cap(focus, MAX_FOCUS_CHARS));
  const symbols = parts.symbols?.trim();
  if (symbols) {
    sections.push(
      '## Enclosing code (current on-disk content; line numbers are the new side)\n' + symbols,
    );
  }
  if (sections.length === 0) return null;
  return cap(sections.join('\n\n'), MAX_CONTEXT_CHARS);
}

/**
 * Local top-K rerank of the LSP completion popup — the JetBrains
 * completionMlRanking recipe at its useful core: reorder ONLY the first
 * RERANK_TOP_K producer-ranked items using local signals (live n-gram over
 * recently completed-in files + typed-prefix quality), leave everything else
 * in producer order, and rewrite just those items' sortText with a
 * leading-space key (a space sorts ahead of every printable producer key).
 * Composes with Monaco's own localityBonus — additive, never replaces the
 * server ranking.
 */
import type * as MonacoNs from 'monaco-editor';
import { NGramIndex, LEX_CAP_CHARS } from '@mcp/shared/editor/ngram.js';

export const RERANK_TOP_K = 5;
/** sortText key that sorts ahead of every printable producer key (0x20 < 0x21+). */
const LOW_SORT_PREFIX = ' ';
/** Relearn a file's n-grams after this many buffer versions drift by. */
const RELEARN_VERSION_DRIFT = 50;

let ngrams = new NGramIndex();

/** Version-gated head-window learn (bounded read — never the whole buffer). */
function learnModel(model: MonacoNs.editor.ITextModel): void {
  const key = model.uri.toString();
  const version = model.getVersionId();
  const learned = ngrams.learnedVersion(key);
  if (learned !== undefined && version - learned < RELEARN_VERSION_DRIFT) return;
  const end = model.getPositionAt(LEX_CAP_CHARS);
  const text = model.getValueInRange({
    startLineNumber: 1, startColumn: 1, endLineNumber: end.lineNumber, endColumn: end.column,
  });
  ngrams.learnFile(key, text, version);
}

interface RerankableEntry {
  label: string;
  sortText?: string;
  filterText?: string;
}

function scoreEntry(entry: RerankableEntry, typed: string, prevToken: string | null): number {
  const text = entry.filterText ?? entry.label;
  let prefix = 0;
  if (typed) {
    if (text.startsWith(typed)) prefix = 1;
    else if (text.toLowerCase().startsWith(typed.toLowerCase())) prefix = 0.7;
  }
  // Labels like `foo(args)` / `bar: Type` score by their identifier head.
  const ident = /^[A-Za-z_$][\w$]*/.exec(entry.label)?.[0] ?? entry.label;
  return 2 * prefix + ngrams.score(prevToken, ident);
}

/**
 * Rerank the top-K in place (sortText rewrite) and return the entries. When
 * local signals agree with the producer order, entries come back untouched —
 * the popup stays byte-identical to today.
 */
export function rerankCompletionEntries<T extends RerankableEntry>(
  entries: T[],
  model: MonacoNs.editor.ITextModel,
  position: MonacoNs.Position,
): T[] {
  if (entries.length < 3) return entries;
  try {
    learnModel(model);
    const lineBefore = model.getLineContent(position.lineNumber).slice(0, position.column - 1);
    const typed = /([A-Za-z_$][\w$]*)$/.exec(lineBefore)?.[1] ?? '';
    // Previous COMPLETE token: what precedes the word being typed.
    const beforeTyped = typed ? lineBefore.slice(0, lineBefore.length - typed.length) : lineBefore;
    const prevToken = /([A-Za-z_$][\w$]*)[^\w$]*$/.exec(beforeTyped)?.[1] ?? null;

    const k = Math.min(RERANK_TOP_K, entries.length);
    const head = entries.slice(0, k).map((entry, index) => ({
      entry, index, score: scoreEntry(entry, typed, prevToken),
    }));
    head.sort((a, b) => b.score - a.score || a.index - b.index); // stable
    if (head.every((h, i) => h.index === i)) return entries; // agreement — untouched
    head.forEach((h, i) => {
      h.entry.sortText = LOW_SORT_PREFIX + i;
    });
    return [...head.map((h) => h.entry), ...entries.slice(k)];
  } catch {
    return entries; // rerank is best-effort — never break completion
  }
}

/** Test hook — drops every learned model. */
export function __resetLocalRerankForTests(): void {
  ngrams = new NGramIndex();
}

/**
 * Live order-2 n-gram over open files — the local-locality signal for the
 * completion popup reranker (JetBrains completionMlRanking's
 * ModelRunnerWithCache, sized identically): learns identifier bigrams from
 * the files the user completes in, bounded by an LRU of MAX_FILES models and
 * a LEX_CAP per file so a giant/minified buffer can't bloat memory or stall
 * a keystroke. Pure string work — shared package, unit-tested.
 */

export const MAX_FILES = 9;
export const LEX_CAP_CHARS = 16 * 1024;

const WORD_RE = /[A-Za-z_$][\w$]*/g;

interface FileModel {
  /** Content version the model was lexed from (staleness check). */
  version: number;
  /** `prev → next → count` bigram table. */
  bigrams: Map<string, Map<string, number>>;
  /** Unigram counts (smoothing denominator + fallback signal). */
  unigrams: Map<string, number>;
  tokenCount: number;
}

export class NGramIndex {
  /** Insertion order = recency (Map preserves it); eldest evicted beyond MAX_FILES. */
  private files = new Map<string, FileModel>();

  /**
   * (Re)learn a file. Cheap no-op when `version` matches what was already
   * learned. Text beyond LEX_CAP_CHARS is ignored (head window — imports and
   * the file's own vocabulary live there).
   */
  learnFile(key: string, text: string, version: number): void {
    const existing = this.files.get(key);
    if (existing?.version === version) {
      this.files.delete(key); // refresh recency
      this.files.set(key, existing);
      return;
    }
    const bigrams = new Map<string, Map<string, number>>();
    const unigrams = new Map<string, number>();
    let tokenCount = 0;
    let prev: string | null = null;
    const window = text.length > LEX_CAP_CHARS ? text.slice(0, LEX_CAP_CHARS) : text;
    for (const match of window.matchAll(WORD_RE)) {
      const token = match[0];
      unigrams.set(token, (unigrams.get(token) ?? 0) + 1);
      tokenCount++;
      if (prev !== null) {
        let next = bigrams.get(prev);
        if (!next) {
          next = new Map();
          bigrams.set(prev, next);
        }
        next.set(token, (next.get(token) ?? 0) + 1);
      }
      prev = token;
    }
    this.files.delete(key);
    this.files.set(key, { version, bigrams, unigrams, tokenCount });
    while (this.files.size > MAX_FILES) {
      const eldest = this.files.keys().next().value;
      if (eldest === undefined) break;
      this.files.delete(eldest); // forget — bounded memory
    }
  }

  forgetFile(key: string): void {
    this.files.delete(key);
  }

  /** Version last learned for a file (undefined = never). */
  learnedVersion(key: string): number | undefined {
    return this.files.get(key)?.version;
  }

  /**
   * Locality score for `candidate` after `prevToken`, in [0, 1]:
   * bigram evidence dominates, unigram familiarity fills in, unseen → 0.
   * Counts are pooled across all learned files (the "project neighborhood").
   */
  score(prevToken: string | null, candidate: string): number {
    let bigramCount = 0;
    let prevTotal = 0;
    let unigramCount = 0;
    let tokens = 0;
    for (const model of this.files.values()) {
      tokens += model.tokenCount;
      unigramCount += model.unigrams.get(candidate) ?? 0;
      if (prevToken !== null) {
        const next = model.bigrams.get(prevToken);
        if (next) {
          bigramCount += next.get(candidate) ?? 0;
          for (const n of next.values()) prevTotal += n;
        }
      }
    }
    if (tokens === 0) return 0;
    // Bigram ratio saturates fast (seeing `foo bar` twice is strong signal);
    // unigram familiarity is a mild prior. Both bounded so the sum stays ≤1.
    const bigram = prevTotal > 0 ? bigramCount / prevTotal : 0;
    const unigram = Math.min(unigramCount / 8, 1);
    return Math.min(0.7 * bigram + 0.3 * unigram, 1);
  }
}

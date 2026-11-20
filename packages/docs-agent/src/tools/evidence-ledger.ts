export const DOCS_BUDGET = { searches: 4, reads: 8, citations: 12, rounds: 6 } as const;

export class DocsEvidenceLedger {
  readonly readChunkIds = new Set<number>();
  private readonly partialReads = new Map<number, { hash: string; spans: [number, number][] }>();
  readonly hitsBySubQuestion = new Map<number, Set<number>>();
  searches = 0;
  reads = 0;

  constructor(
    readonly maxSearches: number = DOCS_BUDGET.searches,
    readonly maxReads: number = DOCS_BUDGET.reads,
    readonly maxCitations: number = DOCS_BUDGET.citations,
  ) {}

  canSearch(): boolean { return this.searches < this.maxSearches; }
  canRead(): boolean { return this.reads < this.maxReads; }

  contentChanged(id: number, hash: string): boolean {
    const read = this.partialReads.get(id);
    return !!read && read.hash !== hash;
  }

  recordSearch(subQuestion: number, chunkIds: readonly number[]): void {
    this.searches++;
    const set = this.hitsBySubQuestion.get(subQuestion) ?? new Set<number>();
    for (const id of chunkIds) set.add(id);
    this.hitsBySubQuestion.set(subQuestion, set);
  }

  recordRead(chunkIds: readonly number[]): void {
    this.reads++;
    for (const id of chunkIds) this.readChunkIds.add(id);
  }

  recordPassages(parts: readonly { id: number; hash: string; start: number; end: number; total: number }[]): void {
    this.reads++;
    for (const { id, hash, start, end, total } of parts) {
      let read = this.partialReads.get(id);
      if (!read || read.hash !== hash) {
        read = { hash, spans: [] };
        this.partialReads.set(id, read);
        this.readChunkIds.delete(id);
      }
      read.spans.push([start, end]);
      read.spans.sort((a, b) => a[0] - b[0]);
      let covered = 0;
      for (const [from, to] of read.spans) {
        if (from > covered) break;
        covered = Math.max(covered, to);
      }
      if (covered >= total) this.readChunkIds.add(id);
    }
  }

  validateHighConfidence(subQuestionCount: number, cited: readonly number[]): string | null {
    if (cited.length > this.maxCitations) return `high confidence accepts at most ${this.maxCitations} cited chunks`;
    const citedSet = new Set(cited);
    const unread = cited.filter((id) => !this.readChunkIds.has(id));
    if (unread.length > 0) return `cited chunks were not read in full: ${unread.join(', ')}`;
    const uncovered: number[] = [];
    for (let index = 0; index < subQuestionCount; index++) {
      const hits = this.hitsBySubQuestion.get(index) ?? new Set<number>();
      if (![...hits].some((id) => this.readChunkIds.has(id) && citedSet.has(id))) uncovered.push(index + 1);
    }
    return uncovered.length > 0 ? `sub-questions without read+cited evidence: ${uncovered.join(', ')}` : null;
  }
}

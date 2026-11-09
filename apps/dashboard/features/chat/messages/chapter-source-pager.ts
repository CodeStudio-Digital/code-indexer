import type { ConversationChapterSourcePage } from '../types.js';

export const CHAPTER_SOURCE_PAGE_SIZE = 100;
export const MAX_OPEN_CHAPTER_SOURCES = 3;
export interface ChapterSourceState {
  expanded: true;
  loading: boolean;
  error: boolean;
  items: ConversationChapterSourcePage['items'];
  toolResults: NonNullable<ConversationChapterSourcePage['tool_results']>;
  precedingUserSeq: number | null;
  nextCursor: string | null;
  /** Only cursor metadata survives navigation; previous page bodies do not. */
  cursors: (string | null)[];
  pageIndex: number;
  retryTarget?: { pageIndex: number; cursor: string | null };
}

type FetchPage = (chapterId: string, cursor: string | null, signal: AbortSignal) => Promise<ConversationChapterSourcePage>;
type SourceStates = Record<string, ChapterSourceState>;

/** One request per navigation, bounded page bodies, and cancellation ownership
 * independent of React rendering. Aborted responses can never reopen a chapter. */
export class ChapterSourcePager {
  private state: SourceStates = {};
  private requests = new Map<string, AbortController>();
  private opened: string[] = [];
  constructor(private fetchPage: FetchPage, private publish: (state: SourceStates) => void) {}

  get snapshot(): SourceStates { return this.state; }

  close(chapterId: string): void {
    this.requests.get(chapterId)?.abort();
    this.requests.delete(chapterId);
    this.opened = this.opened.filter(id => id !== chapterId);
    const next = { ...this.state };
    delete next[chapterId];
    this.state = next;
    this.publish(next);
  }

  dispose(): void {
    for (const controller of this.requests.values()) controller.abort();
    this.requests.clear();
    this.opened = [];
    this.state = {};
  }

  async toggle(chapterId: string): Promise<void> {
    if (this.state[chapterId]) { this.close(chapterId); return; }
    while (this.opened.length >= MAX_OPEN_CHAPTER_SOURCES) this.close(this.opened[0]);
    this.opened.push(chapterId);
    this.set(chapterId, {
      expanded: true, loading: false, error: false, items: [], toolResults: [], precedingUserSeq: null,
      nextCursor: null, cursors: [null], pageIndex: 0,
    });
    await this.load(chapterId, 0, null);
  }

  async next(chapterId: string): Promise<void> {
    const source = this.state[chapterId];
    if (!source || source.loading || !source.nextCursor) return;
    await this.load(chapterId, source.pageIndex + 1, source.nextCursor);
  }

  async previous(chapterId: string): Promise<void> {
    const source = this.state[chapterId];
    if (!source || source.loading || source.pageIndex === 0) return;
    const page = source.pageIndex - 1;
    await this.load(chapterId, page, source.cursors[page]);
  }

  async retry(chapterId: string): Promise<void> {
    const source = this.state[chapterId];
    if (!source || source.loading) return;
    await this.load(chapterId, source.retryTarget?.pageIndex ?? source.pageIndex,
      source.retryTarget ? source.retryTarget.cursor : source.cursors[source.pageIndex]);
  }

  private set(chapterId: string, source: ChapterSourceState): void {
    this.state = { ...this.state, [chapterId]: source };
    this.publish(this.state);
  }

  private async load(chapterId: string, pageIndex: number, cursor: string | null): Promise<void> {
    const source = this.state[chapterId];
    if (!source || source.loading) return;
    const controller = new AbortController();
    this.requests.set(chapterId, controller);
    this.set(chapterId, { ...source, loading: true, error: false });
    const ownsRequest = () => !controller.signal.aborted && this.requests.get(chapterId) === controller;
    try {
      const page = await this.fetchPage(chapterId, cursor, controller.signal);
      if (!ownsRequest()) return;
      const nextCursor = page.next_cursor ?? null;
      // Refuse cyclic cursors without erasing the currently readable page.
      if (nextCursor && (nextCursor === cursor || source.cursors.slice(0, pageIndex).includes(nextCursor))) {
        throw new Error('chapter cursor did not advance');
      }
      const items = [...new Map(page.items.map(item => [item.id, item])).values()]
        .sort((left, right) => left.seq - right.seq);
      this.set(chapterId, {
        expanded: true, loading: false, error: false, items,
        toolResults: page.tool_results ?? [], nextCursor,
        precedingUserSeq: page.preceding_user_seq ?? null,
        cursors: [...source.cursors.slice(0, pageIndex), cursor], pageIndex,
      });
    } catch {
      if (ownsRequest()) this.set(chapterId, {
        ...source, loading: false, error: true, retryTarget: { pageIndex, cursor },
      });
    } finally {
      if (this.requests.get(chapterId) === controller) this.requests.delete(chapterId);
    }
  }
}

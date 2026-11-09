import { describe, expect, it, vi } from 'vitest';
import type { ConversationChapterSourcePage } from '../../types.js';
import { ChapterSourcePager, MAX_OPEN_CHAPTER_SOURCES } from '../chapter-source-pager.js';

function page(start: number, next_cursor: string | null): ConversationChapterSourcePage {
  return { items: Array.from({ length: 100 }, (_, index) => ({ id: `row-${start + index}`, seq: start + index, role: 'assistant', content: [{ type: 'text', text: `message-${start + index}` }] })), next_cursor };
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { resolve, promise };
}

describe('chapter source paging and retention', () => {
  it('shows the first page after one request and requests exactly one page per navigation, with bounded bodies', async () => {
    const fetchPage = vi.fn(async (_id: string, cursor: string | null) => cursor ? page(101, null) : page(1, 'next'));
    const publish = vi.fn();
    const pager = new ChapterSourcePager(fetchPage, publish);
    await pager.toggle('chapter');
    expect(fetchPage).toHaveBeenCalledTimes(1);
    expect(pager.snapshot.chapter.items[0].seq).toBe(1);
    expect(pager.snapshot.chapter.items).toHaveLength(100);
    await pager.next('chapter');
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(pager.snapshot.chapter.items).toHaveLength(100);
    expect(pager.snapshot.chapter.items[0].seq).toBe(101);
    expect(pager.snapshot.chapter.cursors).toEqual([null, 'next']);
    await pager.previous('chapter');
    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(pager.snapshot.chapter.items[0].seq).toBe(1);
    await pager.toggle('chapter');
    expect(pager.snapshot).toEqual({});
    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(publish.mock.lastCall?.[0]).toEqual({});
  });

  it('aborts on collapse and does not resurrect content from a late, non-abortable response', async () => {
    const pending = deferred<ConversationChapterSourcePage>();
    const fetchPage = vi.fn((_id: string, _cursor: string | null, _signal: AbortSignal) => pending.promise);
    const publish = vi.fn();
    const pager = new ChapterSourcePager(fetchPage, publish);
    const loading = pager.toggle('chapter');
    const signal = fetchPage.mock.calls[0][2];
    await pager.toggle('chapter');
    expect(signal.aborted).toBe(true);
    pending.resolve(page(1, 'next'));
    await loading;
    expect(pager.snapshot).toEqual({});
    expect(publish.mock.lastCall?.[0]).toEqual({});
  });

  it('does not let an old response overwrite a newly reopened chapter', async () => {
    const pending = deferred<ConversationChapterSourcePage>();
    const fetchPage = vi.fn().mockReturnValueOnce(pending.promise).mockResolvedValueOnce(page(201, null));
    const pager = new ChapterSourcePager(fetchPage, vi.fn());
    const old = pager.toggle('chapter');
    await pager.toggle('chapter');
    await pager.toggle('chapter');
    pending.resolve(page(1, 'next'));
    await old;
    expect(pager.snapshot.chapter.items[0].seq).toBe(201);
  });

  it('bounds simultaneously expanded chapters and ignores all in-flight responses after session disposal', async () => {
    const pending = deferred<ConversationChapterSourcePage>();
    const publish = vi.fn();
    const pager = new ChapterSourcePager(() => pending.promise, publish);
    const loads = Array.from({ length: MAX_OPEN_CHAPTER_SOURCES + 2 }, (_, index) => pager.toggle(`chapter-${index}`));
    expect(Object.keys(pager.snapshot)).toHaveLength(MAX_OPEN_CHAPTER_SOURCES);
    expect(pager.snapshot['chapter-0']).toBeUndefined();
    pager.dispose();
    const commits = publish.mock.calls.length;
    pending.resolve(page(1, null));
    await Promise.all(loads);
    expect(pager.snapshot).toEqual({});
    expect(publish).toHaveBeenCalledTimes(commits);
  });

  it('deduplicates navigation while loading and preserves readable content on failure or cyclic cursors', async () => {
    const pending = deferred<ConversationChapterSourcePage>();
    const fetchPage = vi.fn().mockResolvedValueOnce(page(1, 'next')).mockReturnValueOnce(pending.promise);
    const pager = new ChapterSourcePager(fetchPage, vi.fn());
    await pager.toggle('chapter');
    const next = pager.next('chapter');
    await pager.next('chapter');
    expect(fetchPage).toHaveBeenCalledTimes(2);
    pending.resolve(page(101, 'next'));
    await next;
    expect(pager.snapshot.chapter.error).toBe(true);
    expect(pager.snapshot.chapter.items[0].seq).toBe(1);
    expect(pager.snapshot.chapter.loading).toBe(false);
  });

  it('carries page-boundary tool results and original user-round metadata with each retained page', async () => {
    const data = { ...page(101, null), preceding_user_seq: 70,
      tool_results: [{ tool_use_id: 'call', content: 'done', is_error: false }] };
    const pager = new ChapterSourcePager(async () => data, vi.fn());
    await pager.toggle('chapter');
    expect(pager.snapshot.chapter.precedingUserSeq).toBe(70);
    expect(pager.snapshot.chapter.toolResults).toEqual(data.tool_results);
    pager.close('chapter');
    expect(pager.snapshot.chapter).toBeUndefined();
  });

  it('retries the failed destination page while preserving the previously readable page', async () => {
    const fetchPage = vi.fn().mockResolvedValueOnce(page(1, 'next'))
      .mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce(page(101, null));
    const pager = new ChapterSourcePager(fetchPage, vi.fn());
    await pager.toggle('chapter');
    await pager.next('chapter');
    expect(pager.snapshot.chapter.items[0].seq).toBe(1);
    expect(pager.snapshot.chapter.error).toBe(true);
    await pager.retry('chapter');
    expect(fetchPage.mock.lastCall?.[1]).toBe('next');
    expect(pager.snapshot.chapter.pageIndex).toBe(1);
    expect(pager.snapshot.chapter.items[0].seq).toBe(101);
    expect(pager.snapshot.chapter.error).toBe(false);
  });
});

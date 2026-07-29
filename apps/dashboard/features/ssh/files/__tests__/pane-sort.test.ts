/**
 * The SFTP panes had no column sorting at all — the headers were resize-only
 * handles with no click, no state and no indicator. These pin the rules the
 * new sort follows, especially the ones that are invariants rather than
 * preferences (directories first, stable ties).
 */
import { describe, expect, it } from 'vitest';
import { DEFAULT_SORT, nextSortState, sortEntries } from '../pane-sort.js';
import type { FsItem } from '../fs-adapter.js';

const it_ = (name: string, over: Partial<FsItem> = {}): FsItem => ({
  name,
  path: `/${name}`,
  type: 'file',
  size: 0,
  mtime: 0,
  mode: 0,
  ...over,
});
const dir = (name: string, over: Partial<FsItem> = {}) => it_(name, { type: 'dir', ...over });
const names = (xs: FsItem[]) => xs.map((x) => x.name);

describe('nextSortState (bi-state)', () => {
  it('flips direction when the same column is clicked again', () => {
    expect(nextSortState({ key: 'name', dir: 'asc' }, 'name')).toEqual({ key: 'name', dir: 'desc' });
    expect(nextSortState({ key: 'name', dir: 'desc' }, 'name')).toEqual({ key: 'name', dir: 'asc' });
  });

  it('switches column and resets to ascending', () => {
    expect(nextSortState({ key: 'name', dir: 'desc' }, 'size')).toEqual({ key: 'size', dir: 'asc' });
  });

  it('never produces an "unsorted" state (it would look identical to name asc)', () => {
    let s = DEFAULT_SORT;
    for (let i = 0; i < 6; i += 1) {
      s = nextSortState(s, 'modified');
      expect(['asc', 'desc']).toContain(s.dir);
      expect(s.key).toBe('modified');
    }
  });
});

describe('sortEntries', () => {
  it('does not mutate the input', () => {
    const input = [it_('b'), it_('a')];
    const copy = [...input];
    sortEntries(input, { key: 'name', dir: 'asc' });
    expect(input).toEqual(copy);
  });

  it('keeps directories first in BOTH directions', () => {
    const entries = [it_('a.txt'), dir('zzz'), it_('b.txt'), dir('aaa')];
    expect(names(sortEntries(entries, { key: 'name', dir: 'asc' }))).toEqual(['aaa', 'zzz', 'a.txt', 'b.txt']);
    expect(names(sortEntries(entries, { key: 'name', dir: 'desc' }))).toEqual(['zzz', 'aaa', 'b.txt', 'a.txt']);
  });

  it('sorts names naturally — file9 before file10, unlike a plain localeCompare', () => {
    const entries = [it_('file10'), it_('file9'), it_('file1')];
    expect(names(sortEntries(entries, { key: 'name', dir: 'asc' }))).toEqual(['file1', 'file9', 'file10']);
  });

  it('sorts by size, descending puts the biggest first', () => {
    const entries = [it_('s', { size: 10 }), it_('l', { size: 9999 }), it_('m', { size: 500 })];
    expect(names(sortEntries(entries, { key: 'size', dir: 'asc' }))).toEqual(['s', 'm', 'l']);
    expect(names(sortEntries(entries, { key: 'size', dir: 'desc' }))).toEqual(['l', 'm', 's']);
  });

  it('sorts by modified time', () => {
    const entries = [it_('old', { mtime: 1 }), it_('new', { mtime: 900 }), it_('mid', { mtime: 50 })];
    expect(names(sortEntries(entries, { key: 'modified', dir: 'desc' }))).toEqual(['new', 'mid', 'old']);
  });

  it('breaks ties on name ascending so the order is STABLE', () => {
    // Every file has size 0 — without a deterministic tiebreak the order could
    // shift between renders and a shift-range selection would jump.
    const entries = [it_('c'), it_('a'), it_('b')];
    const asc = names(sortEntries(entries, { key: 'size', dir: 'asc' }));
    const desc = names(sortEntries(entries, { key: 'size', dir: 'desc' }));
    expect(asc).toEqual(['a', 'b', 'c']);
    expect(desc).toEqual(['a', 'b', 'c']); // tiebreak is NOT reversed
    expect(names(sortEntries(entries, { key: 'size', dir: 'asc' }))).toEqual(asc); // repeatable
  });

  it('handles an empty listing', () => {
    expect(sortEntries([], DEFAULT_SORT)).toEqual([]);
  });
});

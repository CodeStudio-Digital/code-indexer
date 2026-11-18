/**
 * Pure-logic tests for the lazy file-tree store: row flattening and
 * incremental fs-event application (sorted upsert, subtree cleanup).
 * apiCall is mocked — no transport, no DOM.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../lib/api-client.js', () => ({ apiCall: vi.fn() }));

import { useFileTreeStore, visibleRows, compareTreeEntries, type TreeEntry } from '../file-tree.js';
import { apiCall } from '../../lib/api-client.js';

const entry = (path: string, type: 'file' | 'dir', hasChildren?: boolean): TreeEntry => ({
  name: path.split('/').pop() ?? path, path, type, hasChildren,
});

function seed(): void {
  useFileTreeStore.setState({
    projectId: 1,
    children: new Map<string, TreeEntry[]>([
      ['', [entry('src', 'dir', true), entry('readme.md', 'file')]],
      ['src', [entry('src/app', 'dir', true), entry('src/index.ts', 'file')]],
      ['src/app', [entry('src/app/main.ts', 'file')]],
    ]),
    expanded: new Set(['src']),
    loading: new Set(),
    error: null,
    version: 0,
  });
}

beforeEach(seed);

describe('worktree switches', () => {
  it('starts the new root immediately and ignores late success and failure even when switching back', async () => {
    let resolveOld!: (value: unknown) => void;
    let rejectOld!: (error: Error) => void;
    const api = vi.mocked(apiCall);
    api.mockReset().mockReturnValueOnce(new Promise(resolve => { resolveOld = resolve; }))
      .mockReturnValueOnce(new Promise((_, reject) => { rejectOld = reject; }))
      .mockResolvedValue({ children: [entry('current','file')] });
    const store = useFileTreeStore.getState();
    store.init(7);
    const first = store.ensureLoaded('');
    store.init(8);
    const second = store.ensureLoaded('');
    store.init(7);
    await store.ensureLoaded('');
    expect(api.mock.calls.map(call => (call[1] as {projectId: number}).projectId)).toEqual([7,8,7]);
    expect(api.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
    resolveOld({ children: [entry('old','file')] });
    rejectOld(new Error('old failure'));
    await Promise.all([first,second]);
    expect(useFileTreeStore.getState().children.get('')?.map(x=>x.path)).toEqual(['current']);
    expect(useFileTreeStore.getState().error).toBeNull();
  });

  it('restores only reachable expanded paths, including descendants when the parent is reopened', async () => {
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify(['gone','hidden/sub','visible']), setItem: vi.fn() });
    try {
      const api = vi.mocked(apiCall);
      api.mockReset().mockImplementation(async (_name, input) => {
        const {root} = input as {root: string};
        const paths = root === '.' ? ['hidden','visible'] : root === 'hidden' ? ['hidden/sub'] : [];
        return { children: paths.map(path => entry(path,'dir')) };
      });
      useFileTreeStore.getState().init(10);
      await vi.waitFor(() => expect(useFileTreeStore.getState().children.has('visible')).toBe(true));
      expect(api.mock.calls.map(c => (c[1] as {root: string}).root)).toEqual(['.','visible']);
      useFileTreeStore.getState().toggle('hidden');
      await vi.waitFor(() => expect(useFileTreeStore.getState().children.has('hidden/sub')).toBe(true));
    } finally { vi.unstubAllGlobals(); }
  });
});

describe('visibleRows', () => {
  it('flattens only expanded directories, depth-aware', () => {
    const rows = visibleRows(useFileTreeStore.getState());
    expect(rows.map((r) => `${r.depth}:${r.entry.path}`)).toEqual([
      '0:src', '1:src/app', '1:src/index.ts', '0:readme.md',
    ]);
  });

  it('expanding a nested dir surfaces its loaded children', () => {
    useFileTreeStore.setState((s) => ({ expanded: new Set([...s.expanded, 'src/app']) }));
    const rows = visibleRows(useFileTreeStore.getState());
    expect(rows.map((r) => r.entry.path)).toContain('src/app/main.ts');
  });
});

describe('applyFsEvents', () => {
  it('handles a checkout-sized batch without reloading visible directories', () => {
    const store = useFileTreeStore.getState();
    const api = vi.mocked(apiCall);
    api.mockClear();
    store.applyFsEvents(Array.from({ length: 1000 }, (_, i) => ({
      path: i % 2 ? 'src/index.ts' : 'unloaded/file' + i, kind: 'upsert', isDir: false,
    })));
    expect(useFileTreeStore.getState().version).toBe(store.version);
    store.applyFsEvents(Array.from({ length: 1000 }, (_, i) => ({
      path: 'src/new' + i, kind: 'upsert', isDir: false,
    })));
    expect(useFileTreeStore.getState().children.get('src')).toHaveLength(1002);
    expect(api).not.toHaveBeenCalled();
  });
  it('inserts new entries sorted (dirs first, then files alphabetically)', () => {
    useFileTreeStore.getState().applyFsEvents([
      { path: 'src/aaa.ts', kind: 'upsert', isDir: false },
      { path: 'src/zlib', kind: 'upsert', isDir: true },
    ]);
    const src = useFileTreeStore.getState().children.get('src')!;
    expect(src.map((e) => e.path)).toEqual(['src/app', 'src/zlib', 'src/aaa.ts', 'src/index.ts']);
  });

  it('ignores content-change echoes (path already present) and unloaded parents', () => {
    const before = useFileTreeStore.getState().version;
    useFileTreeStore.getState().applyFsEvents([
      { path: 'src/index.ts', kind: 'upsert', isDir: false },        // already listed
      { path: 'unloaded/dir/file.ts', kind: 'upsert', isDir: false }, // parent not loaded
    ]);
    expect(useFileTreeStore.getState().version).toBe(before);
  });

  it('delete of a dir removes the entry, its loaded slices and expansions', () => {
    useFileTreeStore.setState((s) => ({ expanded: new Set([...s.expanded, 'src/app']) }));
    useFileTreeStore.getState().applyFsEvents([{ path: 'src/app', kind: 'delete', isDir: true }]);
    const s = useFileTreeStore.getState();
    expect(s.children.get('src')!.map((e) => e.path)).toEqual(['src/index.ts']);
    expect(s.children.has('src/app')).toBe(false);
    expect(s.expanded.has('src/app')).toBe(false);
  });
});

describe('compareTreeEntries', () => {
  it('dirs first, then locale alphabetical', () => {
    const sorted = [entry('b.ts', 'file'), entry('a', 'dir'), entry('A.ts', 'file')].sort(compareTreeEntries);
    expect(sorted.map((e) => e.path)).toEqual(['a', 'A.ts', 'b.ts']);
  });
});

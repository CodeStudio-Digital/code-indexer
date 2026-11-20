import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionOverlay } from '@mcp/code-agent/overlay/session-overlay.js';
import { getOverlayHandler } from '@mcp/code-agent/overlay/overlay-handlers.js';

describe('SessionOverlay', () => {
  it('normalizes Windows paths and "./" prefix', () => {
    const ov = new SessionOverlay('/project');
    ov.mark('src\\foo.ts');
    ov.mark('./bar.ts');
    expect(ov.isDirty('src/foo.ts')).toBe(true);
    expect(ov.isDirty('bar.ts')).toBe(true);
    expect(ov.isDirty('./bar.ts')).toBe(true);
    expect(ov.isDirty('baz.ts')).toBe(false);
  });

  it('filterDirty returns only paths under a prefix', () => {
    const ov = new SessionOverlay('/project');
    ov.mark('src/a.ts');
    ov.mark('src/nested/b.ts');
    ov.mark('test/c.ts');
    expect(ov.filterDirty('src').sort()).toEqual(['src/a.ts', 'src/nested/b.ts']);
    expect(ov.filterDirty('src/nested')).toEqual(['src/nested/b.ts']);
    expect(ov.filterDirty('test')).toEqual(['test/c.ts']);
    expect(ov.filterDirty().length).toBe(3);
  });

  it('clear empties the dirty set', () => {
    const ov = new SessionOverlay('/p');
    ov.mark('a');
    ov.mark('b');
    ov.clear();
    expect(ov.size()).toBe(0);
  });
});

describe('overlay handlers', () => {
  let root: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'mcp-overlay-'));
    mkdirSync(join(root, 'src'), { recursive: true });
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // read_file, get_symbol_body and grep_code read current disk bytes in the
  // index tool core. Their dirty-file behaviour (disk content, current body,
  // grep honouring glob/language/max_results) is proven end to end through
  // the adapter in apps/http-api/workers/__tests__/overlay-native-reads.test.ts.
  it('has no per-tool copy for tools whose core already reads the disk', () => {
    for (const tool of ['read_file', 'get_symbol_body', 'grep_code']) expect(getOverlayHandler(tool)).toBeUndefined();
  });

  describe('get_file_skeleton', () => {
    it('asks the core for the disk outline of a dirty file only', () => {
      const overlay = new SessionOverlay(root);
      overlay.mark('src/math.ts');
      const handler = getOverlayHandler('get_file_skeleton')!;
      expect(handler.internalArgs!({ file_path: 'src/math.ts' }, overlay)).toEqual({ __prefer_disk: true });
      expect(handler.internalArgs!({ file_path: 'src\\math.ts' }, overlay)).toEqual({ __prefer_disk: true });
      expect(handler.internalArgs!({ file_path: 'src/other.ts' }, overlay)).toBeNull();
      expect(handler.internalArgs!({}, overlay)).toBeNull();
    });
  });

  describe('list_directory postProcess', () => {
    const touch = (path: string) => { mkdirSync(join(root, path, '..'), { recursive: true }); writeFileSync(join(root, path), 'x\n'); };

    it('appends existing dirty files under the prefix, in the listing path form', () => {
      const overlay = new SessionOverlay(root);
      for (const path of ['src/new.ts', 'src/nested/another.ts']) { touch(path); overlay.mark(path); }
      overlay.mark('src/deleted.ts');
      const handler = getOverlayHandler('list_directory')!;
      const result = handler.postProcess!('src/existing.ts (10L)', { path: 'src' }, overlay, root);
      expect(result.content).toBe([
        'src/existing.ts (10L)', '-- session overlay (2) --',
        'src/nested/another.ts [session overlay]', 'src/new.ts [session overlay]',
      ].join('\n'));
    });

    it('never repeats a dirty file the listing already shows', () => {
      const overlay = new SessionOverlay(root);
      touch('src/existing.ts'); overlay.mark('src/existing.ts');
      touch('src/nested/listed.ts'); overlay.mark('src/nested/listed.ts');
      const handler = getOverlayHandler('list_directory')!;
      const listing = 'src/existing.ts (10L)\nsrc/nested/listed.ts (3B)';
      expect(handler.postProcess!(listing, { path: 'src' }, overlay, root).content).toBe(listing);
    });

    it('respects depth and adds nothing beyond the first page', () => {
      const overlay = new SessionOverlay(root);
      touch('src/deep/er/file.ts'); overlay.mark('src/deep/er/file.ts');
      const handler = getOverlayHandler('list_directory')!;
      expect(handler.postProcess!('src/a.ts (1L)', { path: 'src', depth: 1 }, overlay, root).content).toBe('src/a.ts (1L)');
      expect(handler.postProcess!('src/a.ts (1L)', { path: 'src', offset: 1 }, overlay, root).content).toBe('src/a.ts (1L)');
      expect(handler.postProcess!('src/a.ts (1L)', { path: 'src', depth: 2 }, overlay, root).content)
        .toContain('src/deep/er/file.ts [session overlay]');
    });

    it('returns the text unchanged when no dirty files match the prefix', () => {
      const overlay = new SessionOverlay(root);
      touch('other/x.ts'); overlay.mark('other/x.ts');
      const handler = getOverlayHandler('list_directory')!;
      expect(handler.postProcess!('src/foo.ts (1L)\nsrc/bar.ts (1L)', { path: 'src' }, overlay, root).content)
        .toBe('src/foo.ts (1L)\nsrc/bar.ts (1L)');
    });

    it('replaces an empty listing ("Empty.")', () => {
      const overlay = new SessionOverlay(root);
      touch('src/fresh.ts'); overlay.mark('src/fresh.ts');
      const handler = getOverlayHandler('list_directory')!;
      const result = handler.postProcess!('Empty.', { path: 'src' }, overlay, root);
      expect(result.content).not.toContain('Empty.');
      expect(result.content).toContain('src/fresh.ts [session overlay]');
    });
  });

  it('getOverlayHandler returns undefined for unknown tools', () => {
    expect(getOverlayHandler('find_references')).toBeUndefined();
    expect(getOverlayHandler('random_tool')).toBeUndefined();
  });
});

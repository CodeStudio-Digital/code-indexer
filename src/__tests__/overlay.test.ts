import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SessionOverlay } from '../core/coder/overlay/session-overlay.js';
import { getOverlayHandler } from '../core/coder/overlay/overlay-handlers.js';

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

  describe('read_file', () => {
    it('returns disk content for a dirty file and skips delegation', () => {
      const overlay = new SessionOverlay(root);
      writeFileSync(join(root, 'src/foo.ts'), 'line1\nline2\nline3\n');
      overlay.mark('src/foo.ts');

      const handler = getOverlayHandler('read_file')!;
      const result = handler.pre!({ file_path: 'src/foo.ts' }, overlay, root);
      expect(result).not.toBeNull();
      expect(result!.isError).toBeUndefined();
      expect(result!.content).toContain('[session overlay]');
      expect(result!.content).toContain('line1');
      expect(result!.content).toContain('line3');
    });

    it('returns null for clean files (delegates to MCP)', () => {
      const overlay = new SessionOverlay(root);
      const handler = getOverlayHandler('read_file')!;
      const result = handler.pre!({ file_path: 'src/untouched.ts' }, overlay, root);
      expect(result).toBeNull();
    });
  });

  describe('get_file_skeleton', () => {
    it('extracts symbols via regex from a dirty TypeScript file', () => {
      const overlay = new SessionOverlay(root);
      writeFileSync(
        join(root, 'src/math.ts'),
        `export function add(a: number, b: number): number {\n  return a + b;\n}\n\nexport class Calc {\n  multiply(a: number, b: number) { return a * b; }\n}\n`
      );
      overlay.mark('src/math.ts');

      const handler = getOverlayHandler('get_file_skeleton')!;
      const result = handler.pre!({ file_path: 'src/math.ts' }, overlay, root);
      expect(result).not.toBeNull();
      expect(result!.content).toContain('[session overlay]');
      expect(result!.content).toContain('add');
      expect(result!.content).toContain('Calc');
    });
  });

  describe('get_symbol_body', () => {
    it('finds and extracts a function body from a dirty file', () => {
      const overlay = new SessionOverlay(root);
      writeFileSync(
        join(root, 'src/util.ts'),
        `function greet(name: string) {\n  return \`hello \${name}\`;\n}\n\nfunction other() { return 1; }\n`
      );
      overlay.mark('src/util.ts');

      const handler = getOverlayHandler('get_symbol_body')!;
      const result = handler.pre!({ file_path: 'src/util.ts', symbol_name: 'greet' }, overlay, root);
      expect(result).not.toBeNull();
      expect(result!.isError).toBeUndefined();
      expect(result!.content).toContain('greet');
      expect(result!.content).toContain('hello');
      expect(result!.content).toContain('[session overlay]');
    });

    it('returns an error when the symbol is not found in the dirty file', () => {
      const overlay = new SessionOverlay(root);
      writeFileSync(join(root, 'src/empty.ts'), 'const x = 1;\n');
      overlay.mark('src/empty.ts');

      const handler = getOverlayHandler('get_symbol_body')!;
      const result = handler.pre!({ file_path: 'src/empty.ts', symbol_name: 'nope' }, overlay, root);
      expect(result).not.toBeNull();
      expect(result!.isError).toBe(true);
    });

    it('returns null when file is clean (delegates to MCP)', () => {
      const overlay = new SessionOverlay(root);
      const handler = getOverlayHandler('get_symbol_body')!;
      const result = handler.pre!({ file_path: 'src/x.ts', symbol_name: 'foo' }, overlay, root);
      expect(result).toBeNull();
    });
  });

  describe('list_directory postProcess', () => {
    it('appends dirty files under the requested prefix', () => {
      const overlay = new SessionOverlay(root);
      overlay.mark('src/new.ts');
      overlay.mark('src/nested/another.ts');

      const handler = getOverlayHandler('list_directory')!;
      const result = handler.postProcess!('existing.ts (10L)', { path: 'src' }, overlay, root);
      expect(result.content).toContain('existing.ts');
      expect(result.content).toContain('new.ts');
      expect(result.content).toContain('another.ts');
      expect(result.content).toContain('[session overlay]');
    });

    it('returns the MCP text unchanged when no dirty files match prefix', () => {
      const overlay = new SessionOverlay(root);
      overlay.mark('other/x.ts');

      const handler = getOverlayHandler('list_directory')!;
      const result = handler.postProcess!('foo.ts\nbar.ts', { path: 'src' }, overlay, root);
      expect(result.content).toBe('foo.ts\nbar.ts');
    });

    it('handles empty MCP result ("Empty.") correctly', () => {
      const overlay = new SessionOverlay(root);
      overlay.mark('src/fresh.ts');

      const handler = getOverlayHandler('list_directory')!;
      const result = handler.postProcess!('Empty.', { path: 'src' }, overlay, root);
      expect(result.content).not.toContain('Empty.');
      expect(result.content).toContain('fresh.ts');
    });
  });

  describe('grep_code postProcess', () => {
    it('scans dirty files and merges hits into MCP output', () => {
      const overlay = new SessionOverlay(root);
      writeFileSync(join(root, 'src/needle.ts'), 'const magic = 42;\nconsole.log(magic);\n');
      overlay.mark('src/needle.ts');

      const handler = getOverlayHandler('grep_code')!;
      const result = handler.postProcess!(
        'src/old.ts:3: const magic = 0',
        { pattern: 'magic' },
        overlay,
        root
      );
      expect(result.content).toContain('src/old.ts');
      expect(result.content).toContain('src/needle.ts');
      expect(result.content).toContain('[session overlay]');
    });

    it('returns MCP text unchanged when dirty files have no hits', () => {
      const overlay = new SessionOverlay(root);
      writeFileSync(join(root, 'src/clean.ts'), 'const x = 1;\n');
      overlay.mark('src/clean.ts');

      const handler = getOverlayHandler('grep_code')!;
      const result = handler.postProcess!(
        'src/old.ts:3: const magic = 0',
        { pattern: 'magic' },
        overlay,
        root
      );
      expect(result.content).toBe('src/old.ts:3: const magic = 0');
    });
  });

  it('getOverlayHandler returns undefined for unknown tools', () => {
    expect(getOverlayHandler('find_references')).toBeUndefined();
    expect(getOverlayHandler('random_tool')).toBeUndefined();
  });
});

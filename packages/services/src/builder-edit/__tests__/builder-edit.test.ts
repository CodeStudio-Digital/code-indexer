/**
 * Engine contract tests: locate by stamp loc (1-based col = babel col+1),
 * surgical class/text rewrites, refusal rules, newLoc chaining and the
 * reserved-file / stale guards in applyVisualEdit.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { locateAt, parseSource } from '../locate.js';
import { rewriteClasses } from '../rewrite-classes.js';
import { rewriteText } from '../rewrite-text.js';
import { applyVisualEdit, parseStampLoc } from '../apply.js';

const SRC = [
  'export function App() {',
  '  return (',
  '    <div className="p-4 bg-card">',
  "      <h1 className={cn('text-xl font-bold', active && 'underline')}>Olá</h1>",
  '      <p>Hello world</p>',
  '      <span className={dynamic}>x</span>',
  '      <img src="/a.png" />',
  '      <button>{count}</button>',
  '    </div>',
  '  );',
  '}',
  '',
].join('\n');

/** Stamp loc of an element on `line` whose `<` sits at 0-based col → col+1. */
function locOf(line: number, col0: number): { line: number; column: number } {
  return { line, column: col0 + 1 };
}

describe('locate', () => {
  it('finds elements by stamp line/col and reports tag + ordinal', () => {
    const ast = parseSource(SRC);
    const div = locateAt(ast, 3, SRC.split('\n')[2].indexOf('<div') + 1);
    expect(div?.tagName).toBe('div');
    expect(div?.ordinal).toBe(0);
    const p = locateAt(ast, 5, SRC.split('\n')[4].indexOf('<p>') + 1);
    expect(p?.tagName).toBe('p');
    expect(p && p.ordinal > 0).toBe(true);
    expect(locateAt(ast, 99, 1)).toBeNull();
  });
});

describe('rewriteClasses', () => {
  function locate(line: number, snippet: string) {
    const col = SRC.split('\n')[line - 1].indexOf(snippet) + 1;
    return locateAt(parseSource(SRC), line, col)!;
  }

  it('replaces a string-literal className', () => {
    const r = rewriteClasses(SRC, locate(3, '<div').opening, 'p-8 bg-muted');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.code).toContain('<div className="p-8 bg-muted">');
  });

  it('edits the first literal arg of cn(...)', () => {
    const r = rewriteClasses(SRC, locate(4, '<h1').opening, 'text-2xl');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.code).toContain(`cn("text-2xl", active && 'underline')`);
  });

  it('inserts className when absent', () => {
    const r = rewriteClasses(SRC, locate(5, '<p>').opening, 'text-sm');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.code).toContain('<p className="text-sm">');
  });

  it('refuses dynamic className expressions', () => {
    const r = rewriteClasses(SRC, locate(6, '<span').opening, 'x');
    expect(r.ok).toBe(false);
  });
});

describe('rewriteText', () => {
  function element(line: number, snippet: string) {
    const col = SRC.split('\n')[line - 1].indexOf(snippet) + 1;
    return locateAt(parseSource(SRC), line, col)!.element!;
  }

  it('replaces a plain text child preserving surrounding markup', () => {
    const r = rewriteText(SRC, element(5, '<p>'), 'Novo texto');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.code).toContain('<p>Novo texto</p>');
  });

  it('quotes JSX-special characters safely', () => {
    const r = rewriteText(SRC, element(5, '<p>'), 'a < b & {c}');
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.code).toContain('<p>{"a < b & {c}"}</p>');
  });

  it('refuses dynamic children', () => {
    const r = rewriteText(SRC, element(8, '<button'), 'x');
    expect(r.ok).toBe(false);
  });
});

describe('applyVisualEdit', () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'mcp-visual-edit-'));
    const file = join(dir, 'src/App.tsx');
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, SRC);
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  function divLoc(): string {
    return `src/App.tsx:3:${SRC.split('\n')[2].indexOf('<div') + 1}`;
  }

  it('writes the edit and returns a chained newLoc + fileHash', () => {
    const r = applyVisualEdit({
      projectRoot: dir,
      loc: divLoc(),
      op: { kind: 'set-classes', classes: 'p-2' },
      expectTag: 'div',
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(readFileSync(join(dir, 'src/App.tsx'), 'utf-8')).toContain('className="p-2"');
    expect(parseStampLoc(r.newLoc)?.path).toBe('src/App.tsx');
    // Chained second edit with the returned hash succeeds…
    const r2 = applyVisualEdit({
      projectRoot: dir,
      loc: r.newLoc,
      op: { kind: 'set-classes', classes: 'p-6' },
      expectFileHash: r.fileHash,
    });
    expect(r2.ok).toBe(true);
    // …while a stale hash is refused as stale.
    const r3 = applyVisualEdit({
      projectRoot: dir,
      loc: r.newLoc,
      op: { kind: 'set-classes', classes: 'p-8' },
      expectFileHash: r.fileHash,
    });
    expect(r3.ok).toBe(false);
    if (!r3.ok) expect(r3.stale).toBe(true);
  });

  it('refuses tag mismatches as stale', () => {
    const r = applyVisualEdit({
      projectRoot: dir,
      loc: divLoc(),
      op: { kind: 'set-text', text: 'x' },
      expectTag: 'section',
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.stale).toBe(true);
  });

  it('guards reserved files and path escapes', () => {
    for (const loc of ['src/mcp-inspector.ts:1:1', 'vite.config.ts:1:1', '.mcp/x.mjs:1:1', '../out.tsx:1:1']) {
      const r = applyVisualEdit({ projectRoot: dir, loc, op: { kind: 'set-text', text: 'x' } });
      expect(r.ok).toBe(false);
    }
  });
});

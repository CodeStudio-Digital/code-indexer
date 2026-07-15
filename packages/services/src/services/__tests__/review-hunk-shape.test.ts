import { describe, it, expect } from 'vitest';
import { computeHunks } from '../snapshot-hunks.js';
import { classifyHunk, isMechanicalShape } from '../review-hunk-shape.js';

function hunkOf(before: string, after: string) {
  const hunks = computeHunks(before, after);
  expect(hunks.length).toBeGreaterThan(0);
  return hunks[0];
}

describe('classifyHunk', () => {
  it('classifies re-indentation + inner-spacing (prettier-style) as formatting_only', () => {
    const before = 'function f() {\nreturn compute(a,b);\n}\n';
    const after = 'function f() {\n    return compute(a, b);\n}\n';
    const cls = classifyHunk('src/x.ts', hunkOf(before, after));
    expect(cls.shape).toBe('formatting_only');
    expect(isMechanicalShape(cls.shape)).toBe(true);
  });

  it('does NOT classify a content change as formatting', () => {
    const cls = classifyHunk('src/x.ts', hunkOf('if (a && b) run();\n', 'if (a || b) run();\n'));
    expect(cls.shape).toBe('logic');
  });

  // Regression pack for the adversarial-review critical finding: behavioral
  // changes in whitespace-sensitive contexts must NEVER classify mechanical.
  it('never classifies whitespace changes in whitespace-sensitive files as formatting', () => {
    // Python dedent moves do_b() out of the if block.
    const py = classifyHunk('src/app.py', hunkOf('if x:\n    do_a()\n    do_b()\n', 'if x:\n    do_a()\ndo_b()\n'));
    expect(py.shape).toBe('logic');
    // Makefile recipe TAB → spaces breaks make.
    const mk = classifyHunk('Makefile', hunkOf('build:\n\tgcc main.c\n', 'build:\n    gcc main.c\n'));
    expect(mk.shape).toBe('logic');
  });

  it('never classifies whitespace changes inside string literals as formatting', () => {
    const cls = classifyHunk(
      'src/db.ts',
      hunkOf('const q = "SELECT * FROM t";\n', 'const q = "SELECT *FROM t";\n'),
    );
    expect(cls.shape).toBe('logic');
  });

  it('never classifies line-boundary moves (JS ASI) as formatting', () => {
    // Before: `return` on its own line returns undefined; after returns value.
    const cls = classifyHunk('src/x.ts', hunkOf('  return\n    value;\n', '  return value;\n'));
    expect(cls.shape).toBe('logic');
  });

  it('classifies import churn as import_only', () => {
    const before = "import { a } from './a.js';\nconst x = 1;\n";
    const after = "import { a } from './a.js';\nimport { b } from './b.js';\nconst x = 1;\n";
    const cls = classifyHunk('src/x.ts', hunkOf(before, after));
    expect(cls.shape).toBe('import_only');
  });

  it('classifies a consistent token substitution as rename_mechanical with detail', () => {
    const before = 'const oldName = 1;\nexport function use() { return oldName + oldName; }\n';
    const after = 'const newName = 1;\nexport function use() { return newName + newName; }\n';
    // currentContent no longer contains the old token → a true global rename.
    const cls = classifyHunk('src/x.ts', hunkOf(before, after), after);
    expect(cls.shape).toBe('rename_mechanical');
    expect(cls.rename).toEqual({ from: 'oldName', to: 'newName' });
  });

  it('rejects an inconsistent substitution (two different renames) as logic', () => {
    const before = 'use(alpha);\nuse(beta);\n';
    const after = 'use(gamma);\nuse(delta);\n';
    const cls = classifyHunk('src/x.ts', hunkOf(before, after), after);
    expect(cls.shape).toBe('logic');
  });

  it('rejects a semantic swap as rename: old token still alive in the file', () => {
    // Both call sites switch validate → sanitize, but validate still EXISTS
    // in the file — that is a behavioral call-target change, not a rename.
    const before = 'check(validate(a));\nstore(validate(b));\n';
    const after = 'check(sanitize(a));\nstore(sanitize(b));\n';
    const current = `${after}function validate(x) { return x; }\nfunction sanitize(x) { return clean(x); }\n`;
    expect(classifyHunk('src/x.ts', hunkOf(before, after), current).shape).toBe('logic');
  });

  it('rejects a single-line substitution and missing content as rename', () => {
    const before = 'run(oldFn);\n';
    const after = 'run(newFn);\n';
    // One changed pair → logic even when the token is gone.
    expect(classifyHunk('src/x.ts', hunkOf(before, after), after).shape).toBe('logic');
    // No currentContent (oversized/binary) → cannot prove a rename → logic.
    const multi = classifyHunk(
      'src/x.ts',
      hunkOf('a(oldFn);\nb(oldFn);\n', 'a(newFn);\nb(newFn);\n'),
    );
    expect(multi.shape).toBe('logic');
  });

  it('buckets by file type only when the shape is not mechanical', () => {
    const before = 'expect(a).toBe(1);\n';
    const after = 'expect(a).toBe(2);\n';
    expect(classifyHunk('src/__tests__/x.test.ts', hunkOf(before, after)).shape).toBe('test');
    expect(classifyHunk('config/settings.yaml', hunkOf('a: 1\n', 'a: 2\n')).shape).toBe('config');
    expect(classifyHunk('.gitignore', hunkOf('dist\n', 'dist\nbuild\n')).shape).toBe('config');
  });

  it('defaults to logic when in doubt (pure addition of real code)', () => {
    const cls = classifyHunk('src/x.ts', hunkOf('', 'if (!user) throw new Error("missing");\n'));
    expect(cls.shape).toBe('logic');
  });
});

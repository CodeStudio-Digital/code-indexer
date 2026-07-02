import { describe, expect, it } from 'vitest';
import { postProcessV2 } from '../completion/postprocess.js';
import { decideMultiline } from '../completion/multiline.js';

const pp = (raw: string, prefix: string, suffix: string, multiline: boolean) =>
  postProcessV2(raw, { prefix, suffix, multiline });

// ── Legacy contract (migrated verbatim from completion-prompt.test.ts) ─────
describe('postProcessV2 — legacy contract', () => {
  it('strips a wrapping markdown fence', () => {
    const raw = '```ts\nconst x = 1;\n```';
    expect(pp(raw, 'let y;\n', '', true)).toBe('const x = 1;');
  });

  it('cuts the echoed prefix tail', () => {
    const raw = 'const total = items.reduce((a, b) => a + b, 0);';
    const out = pp(raw, 'function sum(items) {\n  const total = ', '', true);
    expect(out).toBe('items.reduce((a, b) => a + b, 0);');
  });

  it('does not cut overlaps shorter than 3 chars (legit repeats)', () => {
    const out = pp('aa + bb', 'x = a', '', true);
    expect(out).toBe('aa + bb');
  });

  it('drops the re-typed suffix head (closing brackets already in buffer)', () => {
    const out = pp('return a + b;\n}', 'function f() {\n  ', '\n}', true);
    expect(out).toBe('return a + b;');
  });

  it('keeps only the first line in single-line mode', () => {
    const out = pp('one();\ntwo();\nthree();', 'x', '', false);
    expect(out).toBe('one();');
  });

  it('removes stray <CURSOR> markers and returns "" when nothing remains', () => {
    expect(pp('<CURSOR>', 'p', 's', true)).toBe('');
    expect(pp('   \n\n', 'p', 's', true)).toBe('');
  });

  it('strips inline <think> reasoning and keeps the code after it', () => {
    const raw = '<think>user wants the class list…</think>SwaggerCommand::class,';
    expect(pp(raw, 'return [\n  ', '', true)).toBe('SwaggerCommand::class,');
  });

  it('returns "" when the token budget died mid-reasoning (unterminated think)', () => {
    expect(pp('<think>still reasoning about', 'p', 's', true)).toBe('');
  });

  it('keeps code but drops a trailing fence + prose', () => {
    const raw = 'return $x;\n```\nThis completes the method.';
    expect(pp(raw, 'function f() {\n  ', '', true)).toBe('return $x;');
  });
});

// ── v2 additions ────────────────────────────────────────────────────────────
describe('postProcessV2 — token-boundary cuts', () => {
  it('does NOT cut `foo` out of `foobar()` (echo cut splits no identifiers)', () => {
    expect(pp('foobar()', 'x = foo', '', true)).toBe('foobar()');
  });

  it('cuts the suffix overlap at a member operator boundary', () => {
    // model re-typed `count()` which the suffix already provides
    expect(pp('items->count()', 'return ', 'count();\n}', true)).toBe('items->');
  });

  it('does not amputate an identifier to satisfy a suffix overlap', () => {
    // suffix starts 'nt(' — cutting 'nt' out of 'count' would split the token
    expect(pp('cou', 'x = ', 'nt();', true)).toBe('cou');
  });
});

describe('postProcessV2 — degenerate output rejection', () => {
  it('rejects a completion that rewrites the line above the cursor', () => {
    const prefix = '  $total = $items->sum();\n  ';
    expect(pp("$total = $items->sum();", prefix, '', true)).toBe('');
  });

  it('truncates 3+ consecutive identical lines (loop)', () => {
    const out = pp('foo();\nbar();\nbar();\nbar();\nbar();', 'x\n', '', true);
    expect(out).toBe('foo();\nbar();');
  });

  it('rejects a ≥3-line completion that only re-types recent prefix lines', () => {
    const prefix = 'alpha();\nbeta();\ngamma();\n';
    expect(pp('alpha();\nbeta();\ngamma();', prefix, '', true)).toBe('');
  });

  it('keeps legitimately repeated short patterns', () => {
    const out = pp("  'a' => 1,\n  'b' => 2,", 'return [\n', '', true);
    expect(out).toBe("  'a' => 1,\n  'b' => 2,");
  });
});

describe('postProcessV2 — bracket guard', () => {
  it('drops an unmatched trailing closer the suffix already provides', () => {
    // completion closes a brace it never opened; the buffer's suffix has it
    expect(pp('return $x;\n  }', 'function f() {\n    if ($y) {\n      ', '\n  }\n}', true))
      .toBe('return $x;');
  });

  it('keeps balanced closers (the completion opened them itself)', () => {
    const out = pp('if ($x) { go(); }', 'x\n', '\n}', true);
    expect(out).toBe('if ($x) { go(); }');
  });
});

// ── multiline decision ──────────────────────────────────────────────────────
describe('decideMultiline', () => {
  it("legacy booleans pass through; 'auto' decides per position", () => {
    expect(decideMultiline(true, 'a', 'b', 'php')).toBe(true);
    expect(decideMultiline(false, '', '', 'php')).toBe(false);
  });

  it('auto: mid-line → single-line', () => {
    expect(decideMultiline('auto', 'if ($x', ') { return; }', 'php')).toBe(false);
  });

  it('auto: comment line → single-line', () => {
    expect(decideMultiline('auto', '  // handles the ', '', 'php')).toBe(false);
  });

  it('auto: fresh line or opener at EOL → multiline', () => {
    expect(decideMultiline('auto', 'function f() {\n    ', '\n}', 'php')).toBe(true);
    expect(decideMultiline('auto', 'const x = [', '', 'typescript')).toBe(true);
    expect(decideMultiline('auto', '$q->where(', '', 'php')).toBe(true);
  });

  it('auto: mid-statement at EOL without opener → single-line', () => {
    expect(decideMultiline('auto', '  $total = $a', '', 'php')).toBe(false);
  });
});

import { describe, expect, it } from 'vitest';
import { offsetAt, validateCompletion } from '../completion/validate.js';

describe.each([
  ['typescript', 'sample.ts', 'function f() {\n  ', '\n}', 'return 1;'],
  ['php', 'sample.php', '<?php\nfunction f() {\n    ', '\n}', 'return 1;'],
  ['python', 'sample.py', 'def f():\n    ', '\n', 'return 1'],
])('completion parsing: %s', (_language, file, prefix, suffix, candidate) => {
  it('accepts a syntactically valid single-line insertion', async () => {
    const original = prefix + suffix;
    await expect(validateCompletion({
      file, original, candidate, offset: prefix.length, prefix, suffix,
    })).resolves.toEqual({ ok: true });
  });

  it('rejects a structurally impossible closer', async () => {
    const original = prefix + suffix;
    await expect(validateCompletion({
      file, original, candidate: ')', offset: prefix.length, prefix, suffix,
    })).resolves.toMatchObject({ ok: false, reason: 'unbalanced' });
  });
});

describe('semantic completion filters', () => {
  it.each([
    ['php', 'x.php', '<?php\nif (ready(', '', ')) {'],
    ['typescript', 'x.ts', 'if (ready(', '', ')) {'],
    ['python', 'x.py', 'values = func(', '', 'other)'],
  ])('accepts a closer inherited from the %s prefix', async (_language, file, prefix, suffix, candidate) => {
    const original = prefix + suffix;
    await expect(validateCompletion({ file, original, candidate, offset: prefix.length, prefix, suffix }))
      .resolves.toMatchObject({ ok: true });
  });

  it('ignores delimiters inside strings and comments', async () => {
    const prefix = 'const value = call(\n';
    const candidate = '  "}", // ]\n)';
    await expect(validateCompletion({
      file: 'x.ts', original: prefix, candidate, offset: prefix.length, prefix, suffix: '',
    })).resolves.toMatchObject({ ok: true });
  });

  it('salvages the longest valid statement prefix from a broken multiline tail', async () => {
    const prefix = 'function f() {\n  ';
    const suffix = '\n}';
    const result = await validateCompletion({
      file: 'x.ts', original: prefix + suffix,
      candidate: 'return 1;\n)', offset: prefix.length, prefix, suffix,
    });
    expect(result).toEqual({ ok: true, candidate: 'return 1;', salvaged: true });
  });

  it('rejects unknown receiver members when the receiver catalog is known', async () => {
    await expect(validateCompletion({
      file: 'x.php', original: '<?php\n$x->', candidate: 'missing()', offset: 10,
      prefix: '<?php\n$x->', suffix: '', memberTriggered: true, knownMembers: ['save', 'find'],
    })).resolves.toMatchObject({ ok: false, reason: 'unknown-member' });
  });

  it('rejects prefix echoes and suffix overlap', async () => {
    await expect(validateCompletion({ file: 'x.ts', original: 'return ', candidate: 'return value;', offset: 7, prefix: 'return ', suffix: '' }))
      .resolves.toMatchObject({ ok: false, reason: 'prefix-echo' });
    await expect(validateCompletion({ file: 'x.ts', original: 'if () {}', candidate: 'value) {}', offset: 4, prefix: 'if (', suffix: ') {}' }))
      .resolves.toMatchObject({ ok: false, reason: 'suffix-overlap' });
  });

  it('maps 1-based Monaco positions to document offsets', () => {
    expect(offsetAt('one\ntwo\nthree', 2, 2)).toBe(5);
  });
});

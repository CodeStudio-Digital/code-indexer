/**
 * Guards the cross-language annotation scope: TS/JS decorators, Python
 * decorators and Rust attributes must all land on `annotation`, the scope the
 * themes paint from one palette entry. Regressions here are invisible in a
 * type-check — the grammar silently keeps emitting `tag`/`identifier` and the
 * annotation just looks like something else.
 */
import { describe, it, expect, vi } from 'vitest';

// The TypeScript grammar module pulls `editor.api.js` (browser globals) just to
// build the `IndentAction`s in its language CONFIG — the `language` grammar we
// extend is plain data. Stub the two constants so the suite stays on the node
// environment; python/rust/php grammars import nothing.
vi.mock('monaco-editor/esm/vs/editor/editor.api.js', () => ({
  languages: { IndentAction: { None: 0, Indent: 1, IndentOutdent: 2, Outdent: 3 } },
}));

// eslint-disable-next-line import/no-unresolved
import { language as baseTs } from 'monaco-editor/esm/vs/basic-languages/typescript/typescript.js';
// eslint-disable-next-line import/no-unresolved
import { language as basePython } from 'monaco-editor/esm/vs/basic-languages/python/python.js';
// eslint-disable-next-line import/no-unresolved
import { language as baseRust } from 'monaco-editor/esm/vs/basic-languages/rust/rust.js';
import {
  ANNOTATION_SPECS,
  enrichAnnotationHighlighting,
  withAnnotations,
} from '../annotation-highlight.js';
import { tokenizeLine, tokenFor } from './monarch-tokenize.js';

const spec = (id: string) => ANNOTATION_SPECS.find((s) => s.id === id)!;
const run = (base: unknown, id: string, line: string) =>
  tokenizeLine(withAnnotations(base, spec(id)), line, { languageId: id });

describe('annotation highlighting', () => {
  it('replaces the tokenizer factory once per language, per Monaco instance', () => {
    const registerTokensProviderFactory = vi.fn((_id: string, _factory: unknown) => ({ dispose() {} }));
    const monaco = { languages: { registerTokensProviderFactory } } as never;

    enrichAnnotationHighlighting(monaco);
    enrichAnnotationHighlighting(monaco);

    expect(registerTokensProviderFactory).toHaveBeenCalledTimes(ANNOTATION_SPECS.length);
    expect(registerTokensProviderFactory.mock.calls.map((c) => c[0]))
      .toEqual(['typescript', 'javascript', 'python', 'rust']);
  });

  it('every spec loads a grammar that still compiles once enriched', async () => {
    for (const s of ANNOTATION_SPECS) {
      const grammar = withAnnotations((await s.load()).language, s);
      expect(() => tokenizeLine(grammar, '', { languageId: s.id })).not.toThrow();
    }
  });

  it('scopes a TypeScript decorator as an annotation', () => {
    const tokens = run(baseTs, 'typescript', "@Injectable({ providedIn: 'root' })");
    expect(tokenFor(tokens, '@Injectable')).toMatch(/^annotation/);
    expect(tokenFor(tokens, 'root')).toMatch(/^string/);
  });

  it('scopes a dotted decorator as one annotation', () => {
    expect(tokenFor(run(baseTs, 'typescript', '@nest.Get()'), '@nest.Get')).toMatch(/^annotation/);
  });

  it('scopes a Python decorator as an annotation, not markup `tag`', () => {
    const tokens = run(basePython, 'python', '@pytest.mark.parametrize');
    expect(tokenFor(tokens, '@pytest.mark.parametrize')).toMatch(/^annotation/);
    expect(tokens.some((t) => t.token.startsWith('tag'))).toBe(false);
  });

  it('scopes a Rust attribute — outer and inner — as an annotation', () => {
    expect(tokenFor(run(baseRust, 'rust', '#[derive(Debug, Clone)]'), 'derive')).toMatch(/^annotation/);
    expect(tokenFor(run(baseRust, 'rust', '#![allow(dead_code)]'), 'allow')).toMatch(/^annotation/);
  });

  it('keeps strings inside a Rust attribute readable, and closes the group', () => {
    const tokens = run(baseRust, 'rust', '#[cfg(feature = "unix")] fn go() {}');
    expect(tokenFor(tokens, 'unix')).toMatch(/^string/);
    expect(tokenFor(tokens, 'fn')).toMatch(/^keyword/);
  });

  it('leaves Rust attribute-adjacent code alone (nested brackets close correctly)', () => {
    const tokens = run(baseRust, 'rust', '#[serde(rename_all = "camelCase")] struct A;');
    expect(tokenFor(tokens, 'struct')).toMatch(/^keyword/);
  });
});

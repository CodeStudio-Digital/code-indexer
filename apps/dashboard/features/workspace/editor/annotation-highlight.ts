/**
 * One colour for annotations, across languages.
 *
 * An annotation is a declaration attached to code — it is NOT a comment, and
 * every language spells it differently: `@Override` (Java/Kotlin/Scala/Dart),
 * `#[derive(...)]` (Rust), `#[Route(...)]` (PHP 8), `@decorator` (TypeScript,
 * Python), `[Attribute]` (C#). Monaco's bundled grammars only agree on the
 * `@Name` family; the rest fall through to whatever their `#`/`@` punctuation
 * rule says:
 *
 *   - Python decorators emit `tag` — the MARKUP scope, so they inherit the
 *     HTML-tag colour and read like JSX instead of like an annotation.
 *   - TypeScript/JavaScript decorators have no rule at all: `@` matches the
 *     operator class and the name lands on `type.identifier`.
 *   - Rust attributes have no rule either; `#` is just a symbol.
 *   - PHP attributes are swallowed by the `#` line-comment rule — handled in
 *     php-highlight.ts, where the whole grammar is already enriched.
 *
 * This module normalises the remaining ones onto the `annotation` scope, which
 * every theme in themes/catalog.ts paints from a single palette entry.
 * Java/Kotlin/Scala/Dart/C++ already emit `annotation`, and our C# rules emit
 * `entity.name.decorator` (same palette entry), so they need nothing here.
 *
 * Grammars are loaded from inside `create()` exactly like Monaco's own lazy
 * factory (see basic-languages/_.contribution.js), so replacing the factory
 * does not pull three more grammars into the editor chunk.
 */
import type * as MonacoNs from 'monaco-editor';

type Monaco = typeof MonacoNs;
type Rules = MonacoNs.languages.IMonarchLanguageRule[];
type Grammar = MonacoNs.languages.IMonarchLanguage & { tokenizer: Record<string, Rules> };

/**
 * `@Injectable()`, `@Component({...})`, `@nest.Get('/')`. Only decorators can
 * carry a `@` immediately followed by an identifier in JS/TS source (docblock
 * `@param` lives in the comment state), so no lookahead is needed.
 */
const TS_ANNOTATION: Rules = [
  [/@[a-zA-Z_$][\w$]*(?:\.[a-zA-Z_$][\w$]*)*/, 'annotation'],
];

/**
 * `@dataclass`, `@app.route('/')`, `@pytest.mark.parametrize`. Same shape as
 * the rule Monaco already ships — it only mis-scopes it as `tag`. Requiring the
 * name to touch the `@` keeps the matrix-multiply operator (`a @ b`) clear.
 */
const PY_ANNOTATION: Rules = [
  [/@[a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*/, 'annotation'],
];

/** `#[derive(Debug)]` and the inner form `#![allow(dead_code)]`. */
const RUST_ANNOTATION: Rules = [
  [/#!?\[/, { token: 'annotation', next: '@rustAttribute' }],
];

/**
 * Rust attribute body. Names paint as `annotation`; everything else falls back
 * to the root grammar so `#[cfg(feature = "unix")]` keeps its string colour.
 * Balanced brackets are tracked so a nested `[...]` can't close it early.
 */
const RUST_ATTRIBUTE_STATE: Rules = [
  [/\]/, { token: 'annotation', next: '@pop' }],
  [/\[/, { token: 'annotation', next: '@push' }],
  [/[a-zA-Z_]\w*/, 'annotation'],
  { include: '@root' },
];

export interface AnnotationSpec {
  /** Monaco language id whose tokens-provider factory we replace. */
  id: string;
  /** Lazy loader for the bundled grammar we extend (never mutated). */
  load: () => Promise<{ language: unknown }>;
  /** Rules prepended to `root`, so they win over the base punctuation rules. */
  rules: Rules;
  /** Extra tokenizer states the rules jump into. */
  states?: Record<string, Rules>;
}

export const ANNOTATION_SPECS: AnnotationSpec[] = [
  {
    id: 'typescript',
    // eslint-disable-next-line import/no-unresolved
    load: () => import('monaco-editor/esm/vs/basic-languages/typescript/typescript.js'),
    rules: TS_ANNOTATION,
  },
  {
    id: 'javascript',
    // eslint-disable-next-line import/no-unresolved
    load: () => import('monaco-editor/esm/vs/basic-languages/javascript/javascript.js'),
    rules: TS_ANNOTATION,
  },
  {
    id: 'python',
    // eslint-disable-next-line import/no-unresolved
    load: () => import('monaco-editor/esm/vs/basic-languages/python/python.js'),
    rules: PY_ANNOTATION,
  },
  {
    id: 'rust',
    // eslint-disable-next-line import/no-unresolved
    load: () => import('monaco-editor/esm/vs/basic-languages/rust/rust.js'),
    rules: RUST_ANNOTATION,
    states: { rustAttribute: RUST_ATTRIBUTE_STATE },
  },
];

/** Clone-and-extend: Monaco's exported `language` objects are shared globals. */
export function withAnnotations(base: unknown, spec: AnnotationSpec): Grammar {
  const grammar = base as Grammar;
  return {
    ...grammar,
    tokenizer: {
      ...grammar.tokenizer,
      ...spec.states,
      root: [...spec.rules, ...grammar.tokenizer.root],
    },
  };
}

const installations = new WeakSet<object>();

/**
 * Replace each language's lazy tokenizer factory with the annotation-aware one.
 * Registering a factory disposes Monaco's atomically, so there is no race with
 * the built-in registration (the failure mode `setMonarchTokensProvider` has).
 */
export function enrichAnnotationHighlighting(monaco: Monaco): void {
  if (installations.has(monaco)) return;
  for (const spec of ANNOTATION_SPECS) {
    monaco.languages.registerTokensProviderFactory(spec.id, {
      create: async () => withAnnotations((await spec.load()).language, spec),
    });
  }
  installations.add(monaco);
}

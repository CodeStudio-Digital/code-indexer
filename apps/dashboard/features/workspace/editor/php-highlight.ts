/**
 * Richer PHP syntax highlighting for Monaco — the IntelliJ-style "function ≠
 * method ≠ property ≠ class" differentiation that the user asked for.
 *
 * Why this exists instead of LSP semantic tokens: the free tier of intelephense
 * does NOT provide semantic tokens (it's a Premium feature — verified: no
 * `semanticTokensProvider` advertised, zero tokens returned). So for the common
 * (free) setup, PHP must be coloured purely from syntax, exactly like VS Code's
 * bundled TextMate grammar does. Monaco's built-in PHP Monarch tokenizer only
 * emits a flat `identifier` for function names, method calls, property access
 * and class names — hence "everything is white".
 *
 * We don't replace Monaco's tokenizer (that would lose its HTML/JS/CSS embedding
 * for PHP templates). Instead we reuse Monaco's own PHP language definition and
 * PREPEND a handful of rules to its `phpRoot` state. The emitted token names map
 * to the same theme scopes our editor themes paint (entity.name.function,
 * entity.name.function.member, variable.other.property, entity.name.type, …),
 * so every bundled theme differentiates them. Token-name → theme-rule matching
 * is by scope prefix, so `entity.name.function.member` (method) wins over
 * `entity.name.function` (function), giving distinct colours.
 *
 * If intelephense Premium is active, its semantic tokens layer on top of this
 * (semantic highlighting renders over the Monarch colours) — strictly better.
 */
import type * as MonacoNs from 'monaco-editor';
// Monaco's own PHP language definition — exported as plain data (no side
// effects / no registration). We clone-and-extend it below.
// eslint-disable-next-line import/no-unresolved
import { language as basePhp } from 'monaco-editor/esm/vs/basic-languages/php/php.js';

type Monaco = typeof MonacoNs;

// PHP language constructs that are written like calls (`isset(...)`, `empty(...)`).
// They live in Monaco's `phpKeywords`, so by default they'd colour as keywords —
// but to a PHP dev they read like `in_array(...)`, so we colour them as functions
// when followed by `(`. NB: control-flow keywords (if/while/for/foreach/switch/
// catch) are deliberately NOT here — they must stay keyword-coloured.
const PHP_CONSTRUCTS = [
  'isset', 'empty', 'unset', 'eval', 'exit', 'die', 'print', 'echo',
  'list', 'include', 'include_once', 'require', 'require_once', 'array',
];

// Rules prepended to `phpRoot`. Order matters: more specific lookahead variants
// (e.g. method call `->name(`) precede the generic ones (property `->name`).
// `white` styles the whitespace capture group (no colour). Token names omit the
// `.php` postfix the base grammar uses; theme matching is by prefix either way.
const EXTRA_PHP_RULES: MonacoNs.languages.IMonarchLanguageRule[] = [
  // ── member access on objects ──────────────────────────────────────
  [/(->)(\s*)([a-zA-Z_]\w*)(?=\s*\()/, ['delimiter.php', 'white', 'entity.name.function.member']],
  [/(->)(\s*)([a-zA-Z_]\w*)/, ['delimiter.php', 'white', 'variable.other.property']],
  // ── static access on classes ──────────────────────────────────────
  [/(::)(\s*)(class\b)/, ['delimiter.php', 'white', 'keyword.php']],
  [/(::)(\s*)(\$[a-zA-Z_]\w*)/, ['delimiter.php', 'white', 'variable.other.property']],
  [/(::)(\s*)([a-zA-Z_]\w*)(?=\s*\()/, ['delimiter.php', 'white', 'entity.name.function.member']],
  [/(::)(\s*)([A-Z_][A-Z0-9_]*)\b/, ['delimiter.php', 'white', 'variable.other.constant']],
  [/(::)(\s*)([a-zA-Z_]\w*)/, ['delimiter.php', 'white', 'variable.other.constant']],
  // ── class name preceding `::` (Cache::, Model::); keep self/parent/static keyword ──
  [/[a-zA-Z_]\w*(?=\s*::)/, { cases: { '@phpKeywords': 'keyword.php', '@default': 'entity.name.type' } }],
  // ── declarations & type positions ─────────────────────────────────
  [/\b(function)(\s+)([a-zA-Z_]\w*)/, ['keyword.php', 'white', 'entity.name.function']],
  [/\b(class|interface|trait|enum)(\s+)([a-zA-Z_]\w*)/, ['keyword.php', 'white', 'entity.name.type']],
  [/\b(new|instanceof)(\s+)([a-zA-Z_]\w*(?:\\\\[a-zA-Z_]\w*)*)/, ['keyword.php', 'white', 'entity.name.type']],
  [/\b(extends|implements)(\s+)([a-zA-Z_]\w*(?:\\\\[a-zA-Z_]\w*)*)/, ['keyword.php', 'white', 'entity.name.type']],
  [/\b(namespace|use)(\s+)([a-zA-Z_]\w*(?:\\\\[a-zA-Z_]\w*)*)/, ['keyword.php', 'white', 'entity.name.namespace']],
  // ── function call (identifier immediately before `(`) ─────────────
  // `@phpConstructs` BEFORE `@phpKeywords` so isset()/empty()/… colour like a
  // function (consistent with in_array()), while if()/while()/for() stay keyword.
  [/[a-zA-Z_]\w*(?=\s*\()/, {
    cases: {
      '@phpConstructs': 'entity.name.function',
      '@phpKeywords': 'keyword.php',
      '@phpCompileTimeConstants': 'constant.php',
      '@default': 'entity.name.function',
    },
  }],
];

/** The rules we prepend — exported for the regression test. */
export const PHP_EXTRA_RULES = EXTRA_PHP_RULES;

/** Build the enriched language def without mutating Monaco's shared object. */
export function enrichedPhp(): MonacoNs.languages.IMonarchLanguage {
  const base = basePhp as unknown as MonacoNs.languages.IMonarchLanguage & {
    tokenizer: { phpRoot: MonacoNs.languages.IMonarchLanguageRule[] };
  };
  return {
    ...base,
    // Referenced as `@phpConstructs` in the function-call rule's `cases`; must be
    // an attribute on the language object or Monarch's compile() throws.
    phpConstructs: PHP_CONSTRUCTS,
    tokenizer: {
      ...base.tokenizer,
      phpRoot: [...EXTRA_PHP_RULES, ...base.tokenizer.phpRoot],
    },
  };
}

/**
 * Install the enriched PHP tokenizer. Registered via `onLanguage` (best-effort,
 * early) — but Monaco's basic-language loads its default tokenizer lazily and
 * asynchronously, which can clobber ours. `reassertPhpHighlighting` (called from
 * the editor mount, after Monaco has fully loaded php) is the deterministic
 * backstop that guarantees ours wins.
 */
export function enrichPhpHighlighting(monaco: Monaco): void {
  const apply = (): void => {
    try { monaco.languages.setMonarchTokensProvider('php', enrichedPhp()); } catch { /* php not ready */ }
  };
  monaco.languages.onLanguage('php', apply);
  try {
    if (monaco.languages.getLanguages().some((l) => l.id === 'php')) apply();
  } catch { /* registry not ready */ }
}

/** Re-assert ours over Monaco's async default. Cheap; call when a php editor mounts. */
export function reassertPhpHighlighting(monaco: Monaco): void {
  try { monaco.languages.setMonarchTokensProvider('php', enrichedPhp()); } catch { /* */ }
}

// ─── Hover for language constructs ──────────────────────────────────
//
// intelephense documents real functions (in_array) but not language constructs
// (isset/empty/list/…) — they have no stub, so hovering them shows nothing. We
// register an extra php hover that returns a short doc for these. Monaco MERGES
// hover providers: for a construct the LSP provider returns null and ours shows;
// for a real function ours returns null and the LSP's shows — no duplicates.
const CONSTRUCT_DOCS: Record<string, { sig: string; doc: string }> = {
  isset: { sig: 'isset(mixed $var, mixed ...$vars): bool', doc: 'Determine if a variable is declared and is different than `null`.' },
  empty: { sig: 'empty(mixed $var): bool', doc: 'Determine whether a variable is considered to be empty (not set, or equal to a falsy value).' },
  unset: { sig: 'unset(mixed $var, mixed ...$vars): void', doc: 'Destroys the specified variables.' },
  eval: { sig: 'eval(string $code): mixed', doc: 'Evaluates the given PHP code as a string. Use with extreme caution.' },
  exit: { sig: 'exit(string|int $status = 0): never', doc: 'Outputs a message and terminates the current script.' },
  die: { sig: 'die(string|int $status = 0): never', doc: 'Equivalent to `exit()` — outputs a message and terminates the script.' },
  print: { sig: 'print(string $expression): int', doc: 'Outputs a string. Unlike `echo`, it is an expression and returns `1`.' },
  echo: { sig: 'echo(string ...$expressions): void', doc: 'Outputs one or more strings. Not a function — no return value.' },
  list: { sig: 'list(mixed ...$vars): array', doc: 'Assigns variables as if they were an array (destructuring).' },
  include: { sig: 'include(string $path): mixed', doc: 'Includes and evaluates the specified file; emits a warning if not found.' },
  include_once: { sig: 'include_once(string $path): mixed', doc: 'Like `include`, but includes the file only once.' },
  require: { sig: 'require(string $path): mixed', doc: 'Includes and evaluates the specified file; a fatal error if not found.' },
  require_once: { sig: 'require_once(string $path): mixed', doc: 'Like `require`, but includes the file only once.' },
  array: { sig: 'array(mixed ...$values): array', doc: 'Creates an array. The short syntax `[...]` is equivalent.' },
};

/**
 * Register the construct-hover provider. Idempotent-friendly: call once from
 * setupMonaco (it persists for the session, like Monaco's built-in providers).
 */
export function registerPhpConstructHover(monaco: Monaco): void {
  monaco.languages.registerHoverProvider('php', {
    provideHover(model, position) {
      const word = model.getWordAtPosition(position);
      if (!word) return null;
      const info = CONSTRUCT_DOCS[word.word];
      if (!info) return null;
      return {
        range: new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn),
        contents: [
          { value: '```php\n' + info.sig + '\n```' },
          { value: info.doc },
        ],
      };
    },
  });
}

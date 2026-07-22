/**
 * TextMate → Monaco bridge: registers languages that Monaco has NO tokenizer
 * for (Vue/Svelte SFCs, TOML, Makefile, diff, Zig, …) and backs them with
 * vscode-textmate grammars. Never touches languages with a working Monarch or
 * LSP story (ts/js/php/…): this is purely additive coverage.
 *
 * Guards mirror JetBrains' textmate plugin: lines beyond LINE_LIMIT are left
 * unstyled (minified/generated files can't stall the renderer), and each line
 * gets a hard time budget inside vscode-textmate (`stoppedEarly`).
 *
 * Cost model: grammars + WASM load only when the FIRST model of one of these
 * languages materializes (`onLanguage`), then Monaco caches line states —
 * steady-state typing re-tokenizes the edited line(s) only.
 */
import type * as MonacoNs from 'monaco-editor';
import { INITIAL, loadTextMateGrammar, type StateStack } from './registry.js';
import { mapScopesToToken } from './scope-map.js';

type Monaco = typeof MonacoNs;

/** JetBrains `textmate.line.highlighting.limit` equivalent. */
const LINE_LIMIT = 20_000;
/** Per-line oniguruma budget — a pathological regex can't freeze a keystroke. */
const LINE_TIME_BUDGET_MS = 200;

interface TmLanguage {
  id: string;
  scope: string;
  extensions?: string[];
  filenames?: string[];
  aliases?: string[];
}

/** Languages Monaco ships no tokenizer for — additive only (see header). */
const TM_LANGUAGES: TmLanguage[] = [
  { id: 'toml', scope: 'source.toml', extensions: ['.toml'], filenames: ['Cargo.lock'], aliases: ['TOML'] },
  {
    id: 'jsonl', scope: 'source.json.lines',
    extensions: ['.jsonl', '.ndjson', '.jsonlines', '.ldjson'], aliases: ['JSON Lines', 'NDJSON'],
  },
  { id: 'json5', scope: 'source.json5', extensions: ['.json5'], aliases: ['JSON5'] },
  { id: 'hjson', scope: 'source.hjson', extensions: ['.hjson'], aliases: ['Hjson'] },
  { id: 'jsonnet', scope: 'source.jsonnet', extensions: ['.jsonnet', '.libsonnet'], aliases: ['Jsonnet'] },
  { id: 'dotenv', scope: 'source.dotenv', extensions: ['.env'], filenames: ['.env'], aliases: ['Dotenv'] },
  { id: 'codeowners', scope: 'text.codeowners', filenames: ['CODEOWNERS'], aliases: ['CODEOWNERS'] },
  { id: 'log', scope: 'text.log', extensions: ['.log'], aliases: ['Log'] },
  { id: 'csv', scope: 'text.csv', extensions: ['.csv'], aliases: ['CSV'] },
  { id: 'tsv', scope: 'text.tsv', extensions: ['.tsv'], aliases: ['TSV'] },
  { id: 'vue', scope: 'text.html.vue', extensions: ['.vue'], aliases: ['Vue'] },
  { id: 'svelte', scope: 'source.svelte', extensions: ['.svelte'], aliases: ['Svelte'] },
  {
    id: 'makefile', scope: 'source.makefile', extensions: ['.mk', '.mak'],
    filenames: ['Makefile', 'makefile', 'GNUmakefile'], aliases: ['Makefile'],
  },
  { id: 'cmake', scope: 'source.cmake', extensions: ['.cmake'], filenames: ['CMakeLists.txt'], aliases: ['CMake'] },
  { id: 'diff', scope: 'source.diff', extensions: ['.diff', '.patch'], aliases: ['Diff'] },
  { id: 'zig', scope: 'source.zig', extensions: ['.zig'], aliases: ['Zig'] },
  { id: 'prisma', scope: 'source.prisma', extensions: ['.prisma'], aliases: ['Prisma'] },
  { id: 'nix', scope: 'source.nix', extensions: ['.nix'], aliases: ['Nix'] },
  { id: 'haskell', scope: 'source.haskell', extensions: ['.hs'], aliases: ['Haskell'] },
];

/** Immutable wrapper — vscode-textmate stacks are shared, never mutated. */
class TmState implements MonacoNs.languages.IState {
  constructor(readonly ruleStack: StateStack) {}
  clone(): TmState {
    return this;
  }
  equals(other: MonacoNs.languages.IState): boolean {
    return other instanceof TmState && other.ruleStack === this.ruleStack;
  }
}

const UNSTYLED = (state: MonacoNs.languages.IState): MonacoNs.languages.ILineTokens => ({
  tokens: [{ startIndex: 0, scopes: '' }],
  endState: state,
});

async function buildProvider(scope: string): Promise<MonacoNs.languages.TokensProvider> {
  const grammar = await loadTextMateGrammar(scope);
  if (!grammar) {
    // Grammar failed to load — plaintext behavior, never an error surface.
    return {
      getInitialState: () => new TmState(INITIAL),
      tokenize: (_line, state) => UNSTYLED(state),
    };
  }
  return {
    getInitialState: () => new TmState(INITIAL),
    tokenize(line, state) {
      if (line.length > LINE_LIMIT) return UNSTYLED(state);
      const prev = (state as TmState).ruleStack;
      const result = grammar.tokenizeLine(line, prev, LINE_TIME_BUDGET_MS);
      const tokens = result.tokens.map((t) => ({
        startIndex: t.startIndex,
        scopes: mapScopesToToken(t.scopes),
      }));
      return {
        tokens,
        endState: result.ruleStack === prev ? state : new TmState(result.ruleStack),
      };
    },
  };
}

/**
 * Register the TextMate-backed languages. Grammar+WASM cost is deferred to
 * each language's first model via `onLanguage`; `setTokensProvider` accepts
 * the Thenable directly (Monaco waits, then swaps highlighting in).
 */
export function registerTextMateHighlighting(monaco: Monaco): void {
  for (const lang of TM_LANGUAGES) {
    monaco.languages.register({
      id: lang.id,
      ...(lang.extensions ? { extensions: lang.extensions } : {}),
      ...(lang.filenames ? { filenames: lang.filenames } : {}),
      ...(lang.aliases ? { aliases: lang.aliases } : {}),
    });
    monaco.languages.onLanguage(lang.id, () => {
      // Await the concrete provider before registering: Monaco 0.52's
      // setTokensProvider does NOT install a Thenable provider (it silently
      // no-ops), which left the file plaintext. Resolve the grammar first,
      // then register — Monaco re-tokenizes open models of this language when
      // a provider is registered, so the deferred install still colors them.
      void buildProvider(lang.scope).then((provider) => {
        monaco.languages.setTokensProvider(lang.id, provider);
      });
    });
  }
}

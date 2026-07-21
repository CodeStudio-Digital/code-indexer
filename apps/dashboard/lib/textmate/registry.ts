/**
 * TextMate grammar registry — oniguruma WASM + vscode-textmate Registry with
 * lazily-imported grammars from tm-grammars (the Shiki collection, MIT).
 *
 * Everything is on-demand: the WASM and a grammar's JSON only load when the
 * first model of a TextMate-backed language materializes (bridge.ts wires
 * `monaco.languages.onLanguage`). Embedded scopes (Vue SFC pulling source.ts,
 * css…) resolve through the same loader map; scopes we don't map degrade
 * gracefully (vscode-textmate skips unresolved includes with a warning).
 * Loader thunks are LITERAL dynamic imports so Vite code-splits one chunk per
 * grammar instead of bundling the whole collection.
 */
import {
  INITIAL,
  Registry,
  type IGrammar,
  type IOnigLib,
  type IRawGrammar,
  type StateStack,
} from 'vscode-textmate';
import { loadWASM, createOnigScanner, createOnigString } from 'vscode-oniguruma';
// Vite turns this into an emitted-asset URL in dev and packaged builds alike —
// fetched at runtime (no CDN), which keeps the Electron CSP story local-only.
import onigWasmUrl from 'vscode-oniguruma/release/onig.wasm?url';

export { INITIAL, type IGrammar, type StateStack };

/**
 * scope → grammar-JSON loader. The first block is the languages we surface in
 * Monaco (bridge.ts); the second exists only so embedded scopes inside them
 * (Vue/Svelte script/style blocks, markdown fences) highlight too.
 */
const GRAMMAR_LOADERS: Record<string, () => Promise<{ default: unknown }>> = {
  'source.toml': () => import('tm-grammars/grammars/toml.json'),
  'text.html.vue': () => import('tm-grammars/grammars/vue.json'),
  'source.svelte': () => import('tm-grammars/grammars/svelte.json'),
  'source.makefile': () => import('tm-grammars/grammars/make.json'),
  'source.cmake': () => import('tm-grammars/grammars/cmake.json'),
  'source.diff': () => import('tm-grammars/grammars/diff.json'),
  'source.zig': () => import('tm-grammars/grammars/zig.json'),
  'source.prisma': () => import('tm-grammars/grammars/prisma.json'),
  'source.nix': () => import('tm-grammars/grammars/nix.json'),
  'source.haskell': () => import('tm-grammars/grammars/haskell.json'),
  // Embedded-only scopes:
  'text.html.basic': () => import('tm-grammars/grammars/html.json'),
  'text.html.derivative': () => import('tm-grammars/grammars/html-derivative.json'),
  'text.html.markdown': () => import('tm-grammars/grammars/markdown.json'),
  'source.css': () => import('tm-grammars/grammars/css.json'),
  'source.css.scss': () => import('tm-grammars/grammars/scss.json'),
  'source.css.less': () => import('tm-grammars/grammars/less.json'),
  'source.css.postcss': () => import('tm-grammars/grammars/postcss.json'),
  'source.ts': () => import('tm-grammars/grammars/typescript.json'),
  'source.tsx': () => import('tm-grammars/grammars/tsx.json'),
  'source.js': () => import('tm-grammars/grammars/javascript.json'),
  'source.js.jsx': () => import('tm-grammars/grammars/jsx.json'),
  'source.json': () => import('tm-grammars/grammars/json.json'),
  'source.yaml': () => import('tm-grammars/grammars/yaml.json'),
};

let onigLib: Promise<IOnigLib> | null = null;
let registry: Registry | null = null;
const grammarCache = new Map<string, Promise<IGrammar | null>>();

function getOnigLib(): Promise<IOnigLib> {
  onigLib ??= (async () => {
    const response = await fetch(onigWasmUrl);
    // `data` (ArrayBuffer) instead of instantiateStreaming: file:// responses
    // in packaged Electron don't always carry the wasm MIME type.
    await loadWASM({ data: await response.arrayBuffer() });
    return { createOnigScanner, createOnigString };
  })();
  return onigLib;
}

function getRegistry(): Registry {
  registry ??= new Registry({
    onigLib: getOnigLib(),
    async loadGrammar(scopeName): Promise<IRawGrammar | null> {
      const load = GRAMMAR_LOADERS[scopeName];
      if (!load) return null; // unmapped embedded scope — degrade quietly
      try {
        const mod = await load();
        return (mod.default ?? mod) as IRawGrammar;
      } catch (err) {
        console.warn(`[textmate] failed to load grammar for ${scopeName}:`, err);
        return null;
      }
    },
  });
  return registry;
}

/** Load (once) and cache the compiled grammar for a scope. Null on failure. */
export function loadTextMateGrammar(scopeName: string): Promise<IGrammar | null> {
  let cached = grammarCache.get(scopeName);
  if (!cached) {
    cached = getRegistry()
      .loadGrammar(scopeName)
      .catch((err) => {
        console.warn(`[textmate] grammar ${scopeName} unavailable:`, err);
        return null;
      });
    grammarCache.set(scopeName, cached);
  }
  return cached;
}

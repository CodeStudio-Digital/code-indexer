/**
 * Bundle Monaco locally instead of CDN-loading it through
 * `@monaco-editor/react`'s default loader.
 *
 * Why: the CDN loader instantiates a single global services container.
 * Strict-mode double-mount in dev (or any rapid mount/unmount) can race
 * the dispose → "InstantiationService has been disposed". Bundling
 * locally + handing the same monaco instance to the loader means React
 * mounts share one already-initialised service, and Vite's `?worker`
 * imports give us proper worker URLs in both dev and the Electron
 * production build (no CDN access at runtime).
 *
 * Workers we care about today: editor (base), TypeScript, JSON, CSS,
 * HTML. Add more here as language features expand.
 *
 * `setupMonaco()` is idempotent — the first call wires everything; the
 * rest are no-ops. Call it before mounting the first Monaco editor.
 * Inside @monaco-editor/react that's any `<Editor />` instance, so we
 * call it from MonacoMount's module scope.
 */

import * as monaco from 'monaco-editor';
import { loader } from '@monaco-editor/react';
// Vite worker imports — each `?worker` URL becomes a Worker class at
// build time. The .ts paths are resolved by Vite's monaco-editor
// optimizer.
import EditorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import TsWorker from 'monaco-editor/esm/vs/language/typescript/ts.worker?worker';
import JsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';
import CssWorker from 'monaco-editor/esm/vs/language/css/css.worker?worker';
import HtmlWorker from 'monaco-editor/esm/vs/language/html/html.worker?worker';

let initialized = false;

export function setupMonaco(): void {
  if (initialized) return;
  initialized = true;

  // Tell Monaco where to find its workers. This runs in the renderer,
  // so the global `self` is the window.
  (self as unknown as { MonacoEnvironment: monaco.Environment }).MonacoEnvironment = {
    getWorker(_workerId, label) {
      switch (label) {
        case 'json':
          return new JsonWorker();
        case 'css':
        case 'scss':
        case 'less':
          return new CssWorker();
        case 'html':
        case 'handlebars':
        case 'razor':
          return new HtmlWorker();
        case 'typescript':
        case 'javascript':
          return new TsWorker();
        default:
          return new EditorWorker();
      }
    },
  };

  // Hand the bundled `monaco` to @monaco-editor/react so it skips the
  // CDN fetch + cdn-side instantiation that was disposing under us.
  loader.config({ monaco });
}

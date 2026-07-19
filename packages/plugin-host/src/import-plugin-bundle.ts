import { pathToFileURL } from 'node:url';

type ModuleImporter<T> = (url: string) => Promise<T>;

type SourceMapControls = {
  sourceMapsEnabled?: boolean;
  setSourceMapsEnabled?: (enabled: boolean) => void;
};

let suppressedImports = 0;
let restoreSourceMapsEnabled: boolean | undefined;

/**
 * Import a built plugin without asking an ambient development loader to
 * generate another inline source map for the already-bundled JavaScript.
 *
 * Electron development runs under `tsx/esm`. When a plugin bundle contains a
 * dynamic import, tsx transforms the entire multi-megabyte bundle and appends
 * a base64 source map. Node's ModuleWrap retains both strings for the lifetime
 * of the process. Provider discovery can load many such bundles, turning a few
 * megabytes on disk into hundreds of megabytes of permanent main-process heap.
 *
 * The suppression is reference-counted because provider settings may import
 * several adapters concurrently. Production/native loaders simply receive the
 * same file URL and are otherwise unaffected.
 */
export async function importPluginBundle<T>(
  file: string,
  importer: ModuleImporter<T> = (url) => import(url) as Promise<T>,
): Promise<T> {
  const runtimeProcess = process as unknown as SourceMapControls;
  const canToggle = typeof runtimeProcess.setSourceMapsEnabled === 'function';

  if (canToggle) {
    if (suppressedImports === 0) {
      restoreSourceMapsEnabled = runtimeProcess.sourceMapsEnabled;
      runtimeProcess.setSourceMapsEnabled!(false);
    }
    suppressedImports++;
  }

  try {
    return await importer(pathToFileURL(file).href);
  } finally {
    if (canToggle) {
      suppressedImports = Math.max(0, suppressedImports - 1);
      if (suppressedImports === 0) {
        // Node/tsx treats an undefined setting as enabled by default.
        runtimeProcess.setSourceMapsEnabled!(restoreSourceMapsEnabled !== false);
        restoreSourceMapsEnabled = undefined;
      }
    }
  }
}

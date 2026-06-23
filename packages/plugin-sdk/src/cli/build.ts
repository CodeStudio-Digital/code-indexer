import { build as esbuild } from 'esbuild';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parsePluginManifest } from '../manifest/schema.js';
import { buildPluginUi } from './build-ui.js';
import type { PluginModule } from '../contributions/types.js';

export interface BuildResult {
  bundle: string;
  appJson: string;
  tools: number;
  /** Self-contained HTML files emitted from `ui/*.template.html` (if any). */
  uiFiles: string[];
}

/**
 * Bundle `src/plugin.ts` → `dist/plugin.js` (single ESM file) and extract the
 * declarative `.app.json` by importing the built module (dropping handlers).
 */
export async function buildPlugin(dir: string): Promise<BuildResult> {
  const root = resolve(dir);
  parsePluginManifest(JSON.parse(await readFile(join(root, 'plugin.json'), 'utf8')));

  const entry = join(root, 'src', 'plugin.ts');
  if (!existsSync(entry)) throw new Error(`a plugin needs src/plugin.ts (missing in ${root})`);

  const bundle = join(root, 'dist', 'plugin.js');
  await esbuild({
    entryPoints: [entry],
    outfile: bundle,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node20',
    logLevel: 'silent',
  });

  const mod = (await import(`${pathToFileURL(bundle).href}?t=${Date.now()}`)) as {
    default?: PluginModule;
  };
  const pm = mod.default;
  if (!pm || !Array.isArray(pm.tools)) {
    throw new Error('plugin entry must `export default definePlugin(...)`');
  }

  const app = {
    worker: './dist/plugin.js',
    tools: pm.tools.map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      ...(t.riskLevel ? { riskLevel: t.riskLevel } : {}),
      ...(t.mutates !== undefined ? { mutates: t.mutates } : {}),
    })),
    toolWindows: pm.toolWindows ?? [],
    commands: pm.commands ?? [],
    themes: pm.themes ?? [],
    ...(pm.permissions ? { permissions: pm.permissions } : {}),
    // Providers are pure-data ProviderSpecs — written verbatim. The host turns
    // each into a runtime definition via buildProviderDefinition; no plugin code
    // is ever imported for a provider.
    ...(pm.providers && pm.providers.length ? { providers: pm.providers } : {}),
  };
  const appJson = join(root, '.app.json');
  await writeFile(appJson, `${JSON.stringify(app, null, 2)}\n`);
  const ui = await buildPluginUi(root);
  return { bundle, appJson, tools: pm.tools.length, uiFiles: ui.written };
}

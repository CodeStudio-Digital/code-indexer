import { mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { PLUGIN_JSON, PLUGIN_TS, PANEL_HTML, GITIGNORE } from './templates.js';

/** Scaffold a new plugin directory `<parentDir>/<slug>`. Returns its path. */
export async function createPlugin(name: string, parentDir = process.cwd()): Promise<string> {
  const slug = name.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
  if (!slug) throw new Error(`invalid plugin name "${name}"`);

  const root = resolve(parentDir, slug);
  if (existsSync(root)) throw new Error(`directory already exists: ${root}`);

  await mkdir(join(root, 'src'), { recursive: true });
  await mkdir(join(root, 'ui'), { recursive: true });
  await writeFile(join(root, 'plugin.json'), PLUGIN_JSON(slug));
  await writeFile(join(root, 'src', 'plugin.ts'), PLUGIN_TS);
  await writeFile(join(root, 'ui', 'panel.html'), PANEL_HTML);
  await writeFile(join(root, '.gitignore'), GITIGNORE);
  return root;
}

// dist flattens workspace source into one application package. External runtime
// dependencies must therefore also be declared by the distributable root.
import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'));
const missing = [];
for (const area of ['apps', 'packages']) {
  for (const entry of await readdir(join(root, area), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    let workspace;
    try { workspace = JSON.parse(await readFile(join(root, area, entry.name, 'package.json'), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    for (const [name, range] of Object.entries(workspace.dependencies ?? {})) {
      if (name.startsWith('@mcp/')) continue;
      if (!manifest.dependencies?.[name] && !manifest.optionalDependencies?.[name]) {
        missing.push(`${workspace.name}: ${name}@${range}`);
      }
    }
  }
}
if (missing.length) throw new Error(`Desktop root is missing runtime dependencies:\n${missing.join('\n')}`);
console.log('Desktop runtime dependencies are declared in the distributable manifest.');

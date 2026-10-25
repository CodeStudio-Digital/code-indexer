import { cp, mkdir, readdir, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// `tsc` emits .js and nothing else, so every non-TS asset a runtime module
// reads from disk has to be mirrored into dist/ by hand — otherwise it exists
// in dev (which runs from source) and silently vanishes from the packaged app.
const ASSETS = [
  { from: 'packages/code-agent/src/prompts', ext: '.txt', label: 'coder prompt' },
  // Builtin Agent Skills, seeded at boot by
  // packages/indexer/src/bootstrap/ensure-builtin-skills.ts.
  { from: 'packages/code-agent/src/skills/builtin', ext: '.md', label: 'builtin skill' },
];

for (const asset of ASSETS) {
  const source = resolve(root, asset.from);
  const target = resolve(root, 'dist', asset.from);
  await mkdir(target, { recursive: true });
  const sourceNames = new Set(await readdir(source));
  for (const entry of await readdir(target, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(asset.ext) && !sourceNames.has(entry.name)) {
      await unlink(resolve(target, entry.name));
    }
  }
  await cp(source, target, {
    recursive: true,
    filter: (path) => path.endsWith(asset.ext) || path === source,
  });
  console.log(`Copied ${asset.label} assets to ${target}`);
}

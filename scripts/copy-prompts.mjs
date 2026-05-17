import { cp, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = resolve(root, 'packages/code-agent/src/prompts');
const target = resolve(root, 'dist/packages/code-agent/src/prompts');

await mkdir(target, { recursive: true });
await cp(source, target, {
  recursive: true,
  filter: (path) => path.endsWith('.txt') || path === source,
});

console.log(`Copied coder prompt assets to ${target}`);

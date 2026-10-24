import { existsSync, lstatSync, readdirSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** tsc does not remove output for deleted source files. Only prune its emitted
 * files; keep copied assets, third-party dependencies and packaged releases. */
export function pruneBuildOutput(root) {
  const workspace = resolve(root);
  const output = join(workspace, 'dist');
  const removed = [];
  // These trees may contain copied or generated JavaScript without a matching
  // source file. They are owned by their asset/package pipeline, not by tsc.
  const assetDirectories = new Set(['vendor', 'node_modules', 'public', 'static', 'assets', 'dist']);
  function visit(directory) {
    if (!existsSync(directory)) return;
    if (lstatSync(directory).isSymbolicLink()) throw new Error(`Unsafe build directory: ${directory}`);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isSymbolicLink()) throw new Error(`Unsafe build entry: ${file}`);
      if (entry.isDirectory()) {
        if (!assetDirectories.has(entry.name)) visit(file);
        continue;
      }
      if (!entry.isFile() || !/\.(?:js(?:\.map)?|d\.ts(?:\.map)?)$/.test(entry.name)) continue;
      const emitted = relative(output, file);
      if (isAbsolute(emitted) || emitted === '..' || emitted.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)) {
        throw new Error(`Build output escaped its directory: ${file}`);
      }
      const sourceBase = join(workspace, emitted.replace(/\.(?:js(?:\.map)?|d\.ts(?:\.map)?)$/, ''));
      if (['.ts', '.tsx', '.js', '.jsx'].some(extension => existsSync(sourceBase + extension))) continue;
      unlinkSync(file);
      removed.push(emitted);
    }
  }
  for (const area of ['apps', 'packages', 'src']) visit(join(output, area));
  return removed;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  console.log(`Removed ${pruneBuildOutput(root).length} stale compiler outputs.`);
}

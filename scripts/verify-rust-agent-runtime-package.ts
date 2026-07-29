import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseRuntimePackageAnchor,
  verifyRuntimePackage,
} from '../packages/agent-runtime-host/src/index.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const anchor = parseRuntimePackageAnchor(
  await readFile(resolve(
    root,
    'dist/apps/electron/native-agent-runtime-integrity.json',
  )),
);
const verified = await verifyRuntimePackage(
  resolve(root, 'dist/native-agent-runtime', anchor.targetTriple),
  anchor,
);

process.stdout.write(
  `Rust agent package verified by host: ${verified.manifest.buildId}`
  + ` binaries=${Object.keys(verified.binaries).length}\n`,
);

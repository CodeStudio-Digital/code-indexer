#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const electron = require('electron');
const tsx = require.resolve('tsx/cli');
const child = resolve(
  root,
  'scripts/rust-agent-installed-smoke/native-addon-child.ts',
);
const anchor = readFileSync(
  resolve(root, 'dist/apps/electron/native-agent-runtime-integrity.json'),
  'utf8',
).trim();
const target = JSON.parse(anchor).targetTriple;
const packageDirectory = resolve(root, 'dist/native-agent-runtime', target);
const result = spawnSync(
  electron,
  [tsx, child, packageDirectory, anchor],
  {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    shell: false,
    timeout: 30_000,
    windowsHide: true,
  },
);
const output = `${result.stdout ?? ''}${result.stderr ?? ''}`;
if (
  result.error
  || result.status !== 0
  || !output.includes('NATIVE_HOST_BRIDGE_SMOKE_OK')
) {
  throw new Error(
    `Electron native Host bridge smoke failed: ${result.error?.message ?? output}`,
  );
}
process.stdout.write(
  `ELECTRON_NATIVE_HOST_BRIDGE_SMOKE_OK target=${target}\n`,
);
